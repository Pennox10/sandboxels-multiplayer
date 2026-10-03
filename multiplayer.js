// Sandboxels Multiplayer Mod
// Mehrere Spieler bearbeiten gleichzeitig dieselbe Welt.
//
// Funktionsweise (Host-autoritativ):
//  - Der Host simuliert die Welt ganz normal.
//  - Mitspieler (Clients) simulieren NICHT selbst. Ihre Maus-Aktionen
//    (Element, Pinselgröße, Linie von/bis ...) werden an den Host geschickt,
//    der sie mit den originalen Sandboxels-Funktionen ausführt.
//    Damit es sich nicht verzögert anfühlt, zeigt der Client seine Striche
//    sofort als Vorschau an; der Host korrigiert sie danach falls nötig.
//  - Der Host schickt nach jedem Tick nur die geänderten Pixel (binär,
//    komprimiert) an alle.
//  - Verbindung per WebRTC über PeerJS (öffentlicher Vermittlungsserver,
//    kein eigener Server nötig). Raumcode = Peer-ID des Hosts.

(function () {
	"use strict";

	const MP_VERSION = 2;
	const PEERJS_URLS = [
		"https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js",
		"https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js",
	];
	const ID_PREFIX = "sbmp-";
	const SYNC_MIN_MS = 28;        // max. ~30 Pixel-Updates pro Sekunde
	const SYNC_IDLE_MS = 50;       // Updates, wenn pausiert
	const CURSOR_MS = 66;          // Cursor-Updates (~15/s)
	const TEMP_STEP = 10;          // Temperaturänderung ab der neu gesendet wird
	const MAX_REMOTE_SIZE = 150;   // max. Pinselgröße für Mitspieler
	const BACKLOG_BYTES = 1024 * 1024; // ab hier werden Updates gesammelt statt gesendet
	const CHUNK = 60000;           // max. Größe einer einzelnen WebRTC-Nachricht
	const PREDICT_MS = 200;        // + Ping: danach Vorschau-Pixel beim Host nachfragen
	const PLAYER_COLORS = ["#ff4d4d", "#4da6ff", "#5cff5c", "#ffd24d", "#ff66ff", "#4dffff", "#ff9933", "#b366ff"];

	// Binär-Nachrichten: [u8 Typ][u8 Flags][u32 pixelTicks][Daten]
	const MSG_DIFF = 1, MSG_FULL = 2, MSG_CHUNK = 9;
	const FLAG_DEFLATE = 1;

	const mp = window.sbMultiplayer = {
		role: null,       // null | "host" | "client"
		peer: null,
		name: localStorage.getItem("sbmp-name") || ("Spieler" + Math.floor(Math.random() * 900 + 100)),
		code: null,
		myId: null,
		players: {},      // id -> {id,name,color,x,y,s,e}
		stats: { sent: 0, recv: 0, syncs: 0, syncMs: 0, ping: 0 },
	};

	// ---------------------------------------------------------------- helpers

	function log(msg) {
		try { logMessage("[MP] " + msg); } catch (e) { console.log("[MP] " + msg); }
		setStatus(msg);
	}

	function loadPeerJS() {
		return new Promise((resolve, reject) => {
			if (window.Peer) return resolve();
			const tryUrl = (i) => {
				if (i >= PEERJS_URLS.length) return reject(new Error("PeerJS konnte nicht geladen werden (Internet/Firewall?)"));
				const s = document.createElement("script");
				s.src = PEERJS_URLS[i];
				s.onload = () => window.Peer ? resolve() : tryUrl(i + 1);
				s.onerror = () => tryUrl(i + 1);
				document.head.appendChild(s);
			};
			tryUrl(0);
		});
	}

	function randomCode() {
		const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
		let c = "";
		for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
		return c;
	}

	// "rgb(1,2,3)" / "#aabbcc" / sonstiges -> 0xRRGGBB
	const colorCache = new Map();
	const colorCtx = document.createElement("canvas").getContext("2d");
	function colorToInt(str) {
		if (typeof str !== "string") return 0xff00ff;
		let v = colorCache.get(str);
		if (v !== undefined) return v;
		if (str.startsWith("rgb")) {
			const m = str.match(/[\d.]+/g);
			v = m ? ((m[0] & 255) << 16) | ((m[1] & 255) << 8) | (m[2] & 255) : 0;
		}
		else {
			colorCtx.fillStyle = "#000";
			colorCtx.fillStyle = str;
			const n = colorCtx.fillStyle; // normalisiert zu #rrggbb oder rgba(...)
			if (n[0] === "#") v = parseInt(n.slice(1, 7), 16);
			else { const m = n.match(/[\d.]+/g); v = m ? ((m[0] & 255) << 16) | ((m[1] & 255) << 8) | (m[2] & 255) : 0; }
		}
		if (colorCache.size > 100000) colorCache.clear();
		colorCache.set(str, v);
		return v;
	}
	const colorStrCache = new Map();
	function intToColor(v) {
		let s = colorStrCache.get(v);
		if (s === undefined) {
			s = "rgb(" + ((v >> 16) & 255) + "," + ((v >> 8) & 255) + "," + (v & 255) + ")";
			if (colorStrCache.size > 100000) colorStrCache.clear();
			colorStrCache.set(v, s);
		}
		return s;
	}

	// Flags: bit0 charge, bit1 burning, bit2 glow=true, bit3 glow=false,
	//        bit4 flipX, bit5 flipY, bit6-7 Rotation r (0-3)
	function pixelFlags(p) {
		let f = 0;
		if (p.charge) f |= 1;
		if (p.burning) f |= 2;
		if (p.glow === true) f |= 4;
		else if (p.glow === false) f |= 8;
		if (p.flipX) f |= 16;
		if (p.flipY) f |= 32;
		if (p.r) f |= (p.r & 3) << 6;
		return f;
	}

	// ---------------------------------------------------- binary / compression

	const canDeflate = typeof CompressionStream === "function" && typeof DecompressionStream === "function";

	async function streamBytes(u8, stream) {
		const out = new Blob([u8]).stream().pipeThrough(stream);
		return new Uint8Array(await new Response(out).arrayBuffer());
	}

	// Baut eine Binär-Nachricht (komprimiert, wenn es sich lohnt)
	async function packMessage(type, ticks, payload) {
		let flags = 0;
		if (canDeflate && payload.length > 256) {
			try {
				const z = await streamBytes(payload, new CompressionStream("deflate-raw"));
				if (z.length < payload.length) { payload = z; flags |= FLAG_DEFLATE; }
			} catch (e) { }
		}
		const out = new Uint8Array(6 + payload.length);
		out[0] = type; out[1] = flags;
		new DataView(out.buffer).setUint32(2, ticks >>> 0, true);
		out.set(payload, 6);
		return out.buffer;
	}

	// Zellen-Liste (aufsteigend sortierte Indizes) aus den prev-Arrays kodieren.
	// Layout: u32 Anzahl | Index-Deltas (varint) | Element u16[] | R[] | G[] | B[] | Flags[] | Alpha[] | Temp i16[]
	function encodeCells(list, count) {
		const pE = host.prevE, pC = host.prevC, pF = host.prevF, pA = host.prevA, pT = host.prevT;
		const buf = new Uint8Array(4 + count * 15);
		new DataView(buf.buffer).setUint32(0, count, true);
		let o = 4, prev = 0;
		for (let k = 0; k < count; k++) {
			let d = list[k] - prev;
			prev = list[k];
			while (d >= 128) { buf[o++] = (d & 127) | 128; d >>>= 7; }
			buf[o++] = d;
		}
		const eo = o, ro = eo + 2 * count, go = ro + count, bo = go + count, fo = bo + count, ao = fo + count, to = ao + count;
		for (let k = 0; k < count; k++) {
			const i = list[k];
			const e = pE[i], c = pC[i], t = pT[i];
			buf[eo + 2 * k] = e & 255; buf[eo + 2 * k + 1] = e >> 8;
			buf[ro + k] = (c >> 16) & 255; buf[go + k] = (c >> 8) & 255; buf[bo + k] = c & 255;
			buf[fo + k] = pF[i]; buf[ao + k] = pA[i];
			buf[to + 2 * k] = t & 255; buf[to + 2 * k + 1] = (t >> 8) & 255;
		}
		return buf.subarray(0, to + 2 * count);
	}

	// ------------------------------------------------------------ hooks setup

	let hooksInstalled = false;
	let internal = 0; // >0: eigene Aufrufe, die nicht abgefangen werden sollen
	const orig = {};

	function installHooks() {
		if (hooksInstalled) return;
		hooksInstalled = true;
		for (const name of ["mouseAction", "tickPixels", "doRandomEvents", "createPixel", "deletePixel", "changePixel", "clearAll", "loadSave", "resizeCanvas"]) {
			orig[name] = window[name];
		}

		window.mouseAction = function (e, mouseX, mouseY, startPos) {
			if (mp.role !== "client" || mouseType === "middle") return orig.mouseAction.apply(this, arguments);
			if (mouseX === undefined && mouseY === undefined) {
				lastPos = mousePos;
				mousePos = getMousePos(canvas, e);
				mouseX = mousePos.x;
				mouseY = mousePos.y;
			}
			startPos = startPos || lastPos;
			sendToHost({
				t: "a",
				b: mouseType,
				x: mouseX, y: mouseY, sx: startPos.x, sy: startPos.y,
				e: currentElement,
				s: mouseSize,
				m: mode,
				sh: shiftDown ? 1 : 0,
				c: currentColor,
				cc: currentColorMap[currentElement],
				ep: currentElementProp,
				p: currentProp,
				pv: currentPropValue,
			});
			predict(mouseType, startPos.x, startPos.y, mouseX, mouseY);
		};

		// Clients simulieren nicht selbst – die Welt kommt komplett vom Host.
		window.tickPixels = function () {
			if (mp.role === "client") return;
			return orig.tickPixels.apply(this, arguments);
		};
		window.doRandomEvents = function () {
			if (mp.role === "client") return;
			return orig.doRandomEvents.apply(this, arguments);
		};
		for (const name of ["createPixel", "deletePixel", "changePixel"]) {
			window[name] = function () {
				if (mp.role === "client" && !internal) return;
				return orig[name].apply(this, arguments);
			};
		}

		window.clearAll = function () {
			if (mp.role === "client" && !internal) {
				sendToHost({ t: "clear" });
				mouseIsDown = false;
				return;
			}
			return orig.clearAll.apply(this, arguments);
		};
		window.loadSave = function () {
			if (mp.role === "client" && !internal) {
				log("Nur der Host kann Spielstände laden.");
				return;
			}
			return orig.loadSave.apply(this, arguments);
		};
		window.resizeCanvas = function () {
			if (mp.role === "client" && !internal) {
				// Größe bleibt an die des Hosts gebunden
				applyHostSize();
				applyBorder(client.border, client.save);
				sendToHost({ t: "full" });
				return;
			}
			return orig.resizeCanvas.apply(this, arguments);
		};

		// Host: direkt nach jedem Simulations-Tick synchronisieren
		runEveryTick(() => {
			if (mp.role === "host" && performance.now() - host.lastSync >= SYNC_MIN_MS) hostSync();
		});
		renderPostPixel(drawRemoteCursors);
		setInterval(updateNetStats, 1000);
	}

	// ------------------------------------------------------------------- host

	const host = {
		conns: {},        // peerId -> {id, conn, player, needsFull, lastPlace, backlog:Set|null}
		elemIds: {},      // name -> id (1..)
		elemNames: [null],
		prevE: null, prevC: null, prevF: null, prevA: null, prevT: null, prevCS: null,
		changed: null,
		W: 0, H: 0,
		syncTimer: null,
		lastSync: 0,
		lastCursor: 0,
		lastPaused: null,
		lastBorder: null,
		queue: Promise.resolve(),
		chunkId: 0,
	};

	// Alle Sendungen laufen nacheinander durch diese Warteschlange,
	// damit die Reihenfolge trotz asynchroner Kompression erhalten bleibt.
	function enqueue(fn) {
		host.queue = host.queue.then(fn).catch(err => console.error("[MP]", err));
	}

	function sendRaw(conn, data) {
		if (!conn.open) return;
		try {
			conn.send(data);
			mp.stats.sent += typeof data === "string" ? data.length : data.byteLength;
		} catch (e) { console.error("[MP] Senden fehlgeschlagen", e); }
	}

	function sendJSON(conn, obj) { sendRaw(conn, JSON.stringify(obj)); }

	// Große Nachrichten in Stücke teilen (WebRTC-Limit)
	function sendBinary(conn, buf) {
		if (buf.byteLength <= CHUNK) return sendRaw(conn, buf);
		const id = ++host.chunkId >>> 0;
		const total = Math.ceil(buf.byteLength / CHUNK);
		const src = new Uint8Array(buf);
		for (let i = 0; i < total; i++) {
			const part = src.subarray(i * CHUNK, Math.min(src.length, (i + 1) * CHUNK));
			const out = new Uint8Array(10 + part.length);
			const dv = new DataView(out.buffer);
			out[0] = MSG_CHUNK;
			dv.setUint32(2, id, true);
			dv.setUint16(6, i, true);
			dv.setUint16(8, total, true);
			out.set(part, 10);
			sendRaw(conn, out.buffer);
		}
	}

	function buffered(c) {
		const dc = c.conn.dataChannel;
		return dc ? dc.bufferedAmount : 0;
	}

	function broadcast(msg) {
		const s = JSON.stringify(msg);
		const targets = Object.values(host.conns);
		enqueue(() => { for (const c of targets) sendRaw(c.conn, s); });
	}

	function broadcastPlayers() {
		broadcast({ t: "players", l: Object.values(mp.players).map(p => ({ id: p.id, name: p.name, color: p.color })) });
	}

	function elemId(name) {
		let id = host.elemIds[name];
		if (id === undefined) {
			id = host.elemNames.length;
			host.elemIds[name] = id;
			host.elemNames.push(name);
			broadcast({ t: "el", id: id, n: name });
		}
		return id;
	}

	function startHost() {
		installHooks();
		setBusy(true);
		loadPeerJS().then(() => {
			const tryOpen = (attempt) => {
				const code = randomCode();
				const peer = new Peer(ID_PREFIX + code);
				peer.on("open", () => {
					mp.peer = peer;
					mp.role = "host";
					mp.code = code;
					mp.myId = peer.id;
					host.elemIds = {};
					host.elemNames = [null];
					for (const name of Object.keys(elements)) elemId(name);
					mp.players = {};
					mp.players[peer.id] = { id: peer.id, name: mp.name, color: PLAYER_COLORS[0], x: 0, y: 0, s: 1, e: "" };
					resetHostBuffers();
					host.syncTimer = setInterval(() => {
						if (performance.now() - host.lastSync >= SYNC_IDLE_MS) hostSync();
					}, SYNC_IDLE_MS / 2);
					setBusy(false);
					log("Raum erstellt! Code: " + code);
					updatePanel();
				});
				peer.on("connection", onHostConnection);
				peer.on("error", (err) => {
					if (err.type === "unavailable-id" && attempt < 5) { peer.destroy(); tryOpen(attempt + 1); return; }
					console.error(err);
					log("Fehler: " + (err.type || err.message));
					if (mp.role !== "host") { peer.destroy(); setBusy(false); updatePanel(); }
				});
				peer.on("disconnected", () => { if (mp.role === "host" && !peer.destroyed) peer.reconnect(); });
			};
			tryOpen(0);
		}).catch((err) => { log(err.message); setBusy(false); });
	}

	function onHostConnection(conn) {
		conn.on("data", (data) => {
			if (typeof data !== "string") {
				// Alte Mod-Version (andere Serialisierung)
				if (data && data.t === "hello") {
					try { conn.send({ t: "err", m: "Andere Mod-Version - bitte Mod aktualisieren!" }); } catch (e) { }
					setTimeout(() => conn.close(), 500);
				}
				return;
			}
			mp.stats.recv += data.length;
			let msg;
			try { msg = JSON.parse(data); } catch (e) { return; }
			try { handleHostMessage(conn, msg); }
			catch (err) { console.error("[MP] Fehler bei Nachricht", msg, err); }
		});
		conn.on("close", () => removeConn(conn.peer));
		conn.on("error", () => removeConn(conn.peer));
	}

	function removeConn(id) {
		const c = host.conns[id];
		if (!c) return;
		delete host.conns[id];
		delete mp.players[id];
		log(c.player.name + " hat das Spiel verlassen.");
		broadcastPlayers();
		updatePanel();
	}

	function handleHostMessage(conn, msg) {
		if (!msg || typeof msg !== "object") return;
		const c = host.conns[conn.peer];
		if (msg.t === "hello") {
			if (msg.v !== MP_VERSION) {
				sendJSON(conn, { t: "err", m: "Andere Mod-Version (Host: " + MP_VERSION + ") - bitte Mod aktualisieren!" });
				setTimeout(() => conn.close(), 500);
				return;
			}
			const used = Object.values(mp.players).map(p => p.color);
			const color = PLAYER_COLORS.find(col => used.indexOf(col) === -1) || PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
			const player = { id: conn.peer, name: String(msg.name || "Spieler").slice(0, 20), color: color, x: -100, y: -100, s: 1, e: "" };
			host.conns[conn.peer] = { id: conn.peer, conn: conn, player: player, needsFull: true, lastPlace: -100, backlog: null };
			mp.players[conn.peer] = player;
			sendJSON(conn, {
				t: "welcome",
				id: conn.peer,
				w: width, h: height,
				border: currentSaveData.border,
				save: { voidX: currentSaveData.voidX, voidY: currentSaveData.voidY, loopX: currentSaveData.loopX, loopY: currentSaveData.loopY },
				elems: host.elemNames,
				paused: !!paused,
			});
			log(player.name + " ist beigetreten.");
			broadcastPlayers();
			updatePanel();
			return;
		}
		if (!c) return;
		switch (msg.t) {
			case "a": applyRemoteAction(c, msg); break;
			case "c":
				c.player.x = msg.x | 0; c.player.y = msg.y | 0; c.player.s = msg.s | 0;
				c.player.e = String(msg.e || "");
				break;
			case "clear": clearAll(); log(c.player.name + " hat die Welt geleert."); break;
			case "pause":
				paused = !!msg.v; manualPaused = paused; checkPause();
				break;
			case "full": c.needsFull = true; break;
			case "ping": {
				const ts = msg.ts;
				enqueue(() => sendJSON(conn, { t: "pong", ts: ts }));
				break;
			}
			case "cells": sendCells(c, msg.l); break;
		}
	}

	// Client fragt den echten Zustand einzelner Zellen nach (Vorschau prüfen)
	function sendCells(c, list) {
		if (!Array.isArray(list) || !host.prevE) return;
		const n = host.prevE.length;
		const idx = Int32Array.from(new Set(list.filter(i => Number.isInteger(i) && i >= 0 && i < n))).sort();
		if (!idx.length) return;
		if (c.backlog || c.needsFull) {
			if (c.backlog) for (const i of idx) c.backlog.add(i);
			return;
		}
		const payload = encodeCells(idx, idx.length).slice();
		const ticks = pixelTicks;
		enqueue(async () => sendBinary(c.conn, await packMessage(MSG_DIFF, ticks, payload)));
	}

	function applyRemoteAction(c, a) {
		if (a.b !== "left" && a.b !== "right") return;
		if (a.b === "left" && !elements[a.e]) return;
		const nums = [a.x, a.y, a.sx, a.sy];
		if (nums.some(n => typeof n !== "number" || !isFinite(n))) return;
		const saved = {
			currentElement, mouseSize, mode, shiftDown, currentColor, currentElementProp,
			currentProp, currentPropValue, lastPos, mousePos, mouseType, lastPlace,
			dragStart, draggingPixels, cc: currentColorMap[a.e],
		};
		try {
			if (elements[a.e]) currentElement = a.e;
			mouseSize = Math.max(1, Math.min(MAX_REMOTE_SIZE, a.s | 0));
			mode = a.m === "replace" ? "replace" : null;
			shiftDown = a.sh ? 1 : 0;
			if (typeof a.c === "string") currentColor = a.c;
			if (typeof a.cc === "string") currentColorMap[a.e] = a.cc;
			currentElementProp = (a.ep && typeof a.ep === "object") ? a.ep : null;
			currentProp = a.p;
			currentPropValue = a.pv;
			mouseType = a.b;
			lastPlace = c.lastPlace;
			dragStart = null;
			draggingPixels = null;
			const start = { x: a.sx | 0, y: a.sy | 0 };
			orig.mouseAction(null, a.x | 0, a.y | 0, start);
			c.lastPlace = lastPlace;
		}
		catch (err) {
			console.error("[MP] Remote-Aktion fehlgeschlagen", err);
		}
		finally {
			currentElement = saved.currentElement; mouseSize = saved.mouseSize; mode = saved.mode;
			shiftDown = saved.shiftDown; currentColor = saved.currentColor;
			currentElementProp = saved.currentElementProp; currentProp = saved.currentProp;
			currentPropValue = saved.currentPropValue; lastPos = saved.lastPos; mousePos = saved.mousePos;
			mouseType = saved.mouseType; lastPlace = saved.lastPlace;
			dragStart = saved.dragStart; draggingPixels = saved.draggingPixels;
			if (saved.cc === undefined) delete currentColorMap[a.e]; else currentColorMap[a.e] = saved.cc;
		}
	}

	function resetHostBuffers() {
		host.W = width + 1;
		host.H = height + 1;
		const n = host.W * host.H;
		host.prevE = new Uint16Array(n);
		host.prevC = new Int32Array(n);
		host.prevF = new Uint8Array(n);
		host.prevA = new Uint8Array(n);
		host.prevT = new Int16Array(n);
		host.prevCS = new Array(n);
		host.changed = new Int32Array(n);
		for (const id in host.conns) { host.conns[id].needsFull = true; host.conns[id].backlog = null; }
	}

	function hostSync() {
		if (mp.role !== "host") return;
		const t0 = performance.now();
		host.lastSync = t0;
		if (width + 1 !== host.W || height + 1 !== host.H) {
			resetHostBuffers();
			broadcast({ t: "size", w: width, h: height });
		}
		// Meta-Infos (Pause, Rand)
		if (host.lastPaused !== !!paused) {
			host.lastPaused = !!paused;
			broadcast({ t: "paused", v: host.lastPaused });
		}
		const borderKey = currentSaveData.border + "|" + currentSaveData.voidX + currentSaveData.voidY + currentSaveData.loopX + currentSaveData.loopY;
		if (host.lastBorder !== borderKey) {
			host.lastBorder = borderKey;
			broadcast({ t: "border", border: currentSaveData.border, save: { voidX: currentSaveData.voidX, voidY: currentSaveData.voidY, loopX: currentSaveData.loopX, loopY: currentSaveData.loopY } });
		}

		// Welt scannen und Änderungen gegenüber dem zuletzt gesendeten Stand sammeln
		const W = host.W, H = host.H;
		const pE = host.prevE, pC = host.prevC, pF = host.prevF, pA = host.prevA, pT = host.prevT, pCS = host.prevCS;
		const changed = host.changed;
		let count = 0;
		for (let y = 0; y < H; y++) {
			const row = y * W;
			for (let x = 0; x < W; x++) {
				const i = row + x;
				const col = pixelMap[x];
				let p = col ? col[y] : undefined;
				if (!p || p.del) {
					if (pE[i] !== 0) {
						pE[i] = 0; pC[i] = 0; pF[i] = 0; pA[i] = 0; pT[i] = 0; pCS[i] = undefined;
						changed[count++] = i;
					}
					continue;
				}
				if (p.con && elements[p.element] && elements[p.element].canContain === true && elements[p.con.element]) p = p.con;
				const e = elemId(p.element);
				const cs = p.color;
				const c = cs === pCS[i] ? pC[i] : colorToInt(cs);
				const f = pixelFlags(p);
				const a = p.alpha === undefined ? 255 : Math.max(0, Math.min(254, Math.round(p.alpha * 254)));
				let t = Math.round(p.temp);
				if (!(t === t)) t = 20;
				if (t > 32767) t = 32767; else if (t < -32768) t = -32768;
				if (e !== pE[i] || c !== pC[i] || f !== pF[i] || a !== pA[i] || Math.abs(t - pT[i]) >= TEMP_STEP) {
					pE[i] = e; pC[i] = c; pF[i] = f; pA[i] = a; pT[i] = t; pCS[i] = cs;
					changed[count++] = i;
				}
			}
		}

		// Cursor des Hosts aktualisieren
		const me = mp.players[mp.myId];
		if (me) { me.x = mousePos.x; me.y = mousePos.y; me.s = mouseSize; me.e = currentElement; }

		const conns = Object.values(host.conns);
		if (conns.length) {
			const ticks = pixelTicks;
			const changedList = count ? changed.slice(0, count) : null;
			const diff = count ? encodeCells(changedList, count).slice() : null;
			let full = null;
			const jobs = [];
			for (const c of conns) {
				if (c.needsFull) {
					if (!full) full = buildFull();
					c.needsFull = false;
					c.backlog = null;
					jobs.push([c, full, MSG_FULL]);
				}
				else if (c.backlog) {
					if (changedList) for (let k = 0; k < count; k++) c.backlog.add(changedList[k]);
				}
				else if (diff) {
					jobs.push([c, diff, MSG_DIFF]);
				}
			}
			enqueue(async () => {
				const packed = new Map();
				for (const [c, payload, type] of jobs) {
					if (host.conns[c.id] !== c) continue;
					// Verbindung kommt nicht hinterher -> Änderungen sammeln und später gebündelt senden
					if (type === MSG_DIFF && buffered(c) > BACKLOG_BYTES) {
						c.backlog = new Set(changedList);
						continue;
					}
					let msg = packed.get(payload);
					if (!msg) { msg = await packMessage(type, ticks, payload); packed.set(payload, msg); }
					sendBinary(c.conn, msg);
				}
				for (const c of conns) {
					if (!c.backlog || host.conns[c.id] !== c || buffered(c) > BACKLOG_BYTES / 4) continue;
					const list = Int32Array.from(c.backlog).sort();
					c.backlog = null;
					if (list.length) sendBinary(c.conn, await packMessage(MSG_DIFF, pixelTicks, encodeCells(list, list.length).slice()));
				}
			});
			if (t0 - host.lastCursor >= 100) {
				host.lastCursor = t0;
				broadcast({ t: "cur", l: Object.values(mp.players).map(p => [p.id, p.x, p.y, p.s, p.e]) });
			}
		}
		mp.stats.syncs++;
		mp.stats.syncMs += performance.now() - t0;
	}

	// Kompletter Zustand aus den prev-Arrays (die gerade aktualisiert wurden)
	function buildFull() {
		const pE = host.prevE;
		const list = new Int32Array(pE.length);
		let n = 0;
		for (let i = 0; i < pE.length; i++) if (pE[i] !== 0) list[n++] = i;
		return encodeCells(list, n).slice();
	}

	// ----------------------------------------------------------------- client

	const client = {
		conn: null,
		W: 0, H: 0,
		elemNames: [null],
		hostPaused: false,
		border: 0,
		save: null,
		timer: null,
		lastCursor: "",
		lastPing: 0,
		queue: Promise.resolve(),
		chunks: {},
		pred: new Map(),   // Zellindex -> Zeitpunkt der Vorschau
	};

	function joinRoom(code) {
		code = String(code || "").trim().toUpperCase().replace(/^SBMP-/i, "");
		if (!code) { log("Bitte einen Raumcode eingeben."); return; }
		installHooks();
		setBusy(true);
		loadPeerJS().then(() => {
			const peer = new Peer();
			mp.peer = peer;
			peer.on("open", () => {
				const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: "raw" });
				client.conn = conn;
				const timeout = setTimeout(() => {
					if (mp.role !== "client") { log("Keine Antwort vom Host (gleiche Mod-Version?)."); leave(); }
				}, 15000);
				conn.on("open", () => {
					conn.send(JSON.stringify({ t: "hello", name: mp.name, v: MP_VERSION }));
				});
				conn.on("data", (data) => {
					if (typeof data === "string" && data.indexOf('"welcome"') !== -1) clearTimeout(timeout);
					client.queue = client.queue
						.then(() => handleClientData(data))
						.catch(err => console.error("[MP] Fehler bei Nachricht", err));
				});
				conn.on("close", () => { if (mp.role === "client") { log("Verbindung zum Host getrennt."); leave(); } });
				conn.on("error", (err) => { console.error(err); });
			});
			peer.on("error", (err) => {
				console.error(err);
				if (err.type === "peer-unavailable") log("Raum \"" + code + "\" nicht gefunden.");
				else log("Fehler: " + (err.type || err.message));
				if (mp.role !== "client") leave();
			});
		}).catch((err) => { log(err.message); setBusy(false); });
	}

	function sendToHost(msg) {
		if (mp.role === "client" && client.conn && client.conn.open) {
			const s = JSON.stringify(msg);
			client.conn.send(s);
			mp.stats.sent += s.length;
		}
	}

	async function handleClientData(data) {
		if (typeof data === "string") {
			mp.stats.recv += data.length;
			handleClientMessage(JSON.parse(data));
			return;
		}
		let u8;
		if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
		else if (data && data.buffer instanceof ArrayBuffer) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		else if (data instanceof Blob) u8 = new Uint8Array(await data.arrayBuffer());
		else return;
		mp.stats.recv += u8.length;
		if (u8[0] === MSG_CHUNK) {
			const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
			const id = dv.getUint32(2, true), idx = dv.getUint16(6, true), total = dv.getUint16(8, true);
			const ch = client.chunks[id] || (client.chunks[id] = { parts: [], got: 0 });
			if (!ch.parts[idx]) { ch.parts[idx] = u8.slice(10); ch.got++; }
			if (ch.got < total) return;
			delete client.chunks[id];
			let len = 0;
			for (const p of ch.parts) len += p.length;
			u8 = new Uint8Array(len);
			let o = 0;
			for (const p of ch.parts) { u8.set(p, o); o += p.length; }
		}
		if (mp.role !== "client") return;
		const type = u8[0], flags = u8[1];
		const ticks = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(2, true);
		let payload = u8.subarray(6);
		if (flags & FLAG_DEFLATE) payload = await streamBytes(payload, new DecompressionStream("deflate-raw"));
		if (mp.role !== "client") return;
		if (type === MSG_DIFF || type === MSG_FULL) {
			applyCells(payload, type === MSG_FULL);
			pixelTicks = ticks;
			lastPixelDraw = -1; // neu zeichnen
		}
	}

	function applyHostSize() {
		internal++;
		try {
			const ps = pixelSize;
			orig.resizeCanvas(client.H * ps, client.W * ps, ps, true, true);
		}
		finally { internal--; }
		currentPixels = [];
		client.pred.clear();
	}

	function applyBorder(border, save) {
		client.border = border | 0;
		client.save = save || null;
		currentSaveData.border = client.border;
		if (save) Object.assign(currentSaveData, save);
	}

	function handleClientMessage(msg) {
		if (!msg || typeof msg !== "object") return;
		switch (msg.t) {
			case "welcome":
				mp.role = "client";
				mp.myId = msg.id;
				client.W = msg.w + 1; client.H = msg.h + 1;
				client.elemNames = msg.elems;
				applyHostSize();
				applyBorder(msg.border, msg.save);
				setHostPaused(msg.paused);
				client.timer = setInterval(clientLoop, CURSOR_MS);
				setBusy(false);
				log("Mit Raum " + client.conn.peer.slice(ID_PREFIX.length) + " verbunden!");
				mp.code = client.conn.peer.slice(ID_PREFIX.length);
				updatePanel();
				break;
			case "err":
				log("Host: " + msg.m);
				break;
			case "el":
				client.elemNames[msg.id] = msg.n;
				break;
			case "size":
				client.W = msg.w + 1; client.H = msg.h + 1;
				applyHostSize();
				applyBorder(client.border, client.save);
				break;
			case "border":
				applyBorder(msg.border, msg.save);
				break;
			case "paused":
				setHostPaused(msg.v);
				break;
			case "pong":
				mp.stats.ping = Math.round(performance.now() - msg.ts);
				break;
			case "players": {
				const old = mp.players;
				mp.players = {};
				for (const p of msg.l) {
					mp.players[p.id] = Object.assign(old[p.id] || { x: -100, y: -100, s: 1, e: "" }, p);
				}
				updatePanel();
				break;
			}
			case "cur":
				for (const [id, x, y, s, e] of msg.l) {
					if (id === mp.myId) continue;
					const p = mp.players[id];
					if (p) { p.x = x; p.y = y; p.s = s; p.e = e; }
				}
				lastPixelDraw = -1;
				break;
		}
	}

	function setHostPaused(v) {
		client.hostPaused = !!v;
		paused = client.hostPaused;
		manualPaused = paused;
		try { checkPause(); } catch (e) { }
	}

	function applyCells(u8, isFull) {
		const W = client.W;
		const pred = client.pred;
		if (isFull) {
			currentPixels = [];
			for (let x = 0; x < pixelMap.length; x++) {
				const col = pixelMap[x];
				if (col) for (let y = 0; y < col.length; y++) col[y] = undefined;
			}
			pred.clear();
		}
		const count = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0, true);
		let o = 4, idx = 0;
		const idxs = new Int32Array(count);
		for (let k = 0; k < count; k++) {
			let v = 0, shift = 0, b;
			do { b = u8[o++]; v += (b & 127) * Math.pow(2, shift); shift += 7; } while (b & 128);
			idx += v;
			idxs[k] = idx;
		}
		const eo = o, ro = eo + 2 * count, go = ro + count, bo = go + count, fo = bo + count, ao = fo + count, to = ao + count;
		const checkPred = pred.size > 0;
		for (let k = 0; k < count; k++) {
			const i = idxs[k];
			const x = i % W, y = (i - x) / W;
			const col = pixelMap[x];
			if (!col) continue;
			if (checkPred) pred.delete(i);
			const e = u8[eo + 2 * k] | (u8[eo + 2 * k + 1] << 8);
			let p = col[y];
			if (e === 0) {
				if (p) { p.del = true; col[y] = undefined; }
				continue;
			}
			if (!p) {
				p = { x: x, y: y, start: 0 };
				col[y] = p;
				currentPixels.push(p);
			}
			const name = client.elemNames[e];
			if (name && elements[name]) { p.element = name; delete p.invalidElement; }
			else { p.element = "unknown"; p.invalidElement = name || "???"; }
			p.color = intToColor((u8[ro + k] << 16) | (u8[go + k] << 8) | u8[bo + k]);
			const f = u8[fo + k];
			if (f & 1) p.charge = 1; else delete p.charge;
			if (f & 2) p.burning = true; else delete p.burning;
			if (f & 4) p.glow = true; else if (f & 8) p.glow = false; else delete p.glow;
			if (f & 16) p.flipX = true; else delete p.flipX;
			if (f & 32) p.flipY = true; else delete p.flipY;
			const r = (f >> 6) & 3;
			if (r) p.r = r; else delete p.r;
			const a = u8[ao + k];
			if (a === 255) delete p.alpha; else p.alpha = a / 254;
			let t = u8[to + 2 * k] | (u8[to + 2 * k + 1] << 8);
			if (t & 0x8000) t -= 0x10000;
			p.temp = t;
		}
	}

	// Sofort-Vorschau: eigene Striche direkt anzeigen, ohne auf den Host zu warten
	function predict(type, sx, sy, x, y) {
		if (type === "left") {
			const info = elements[currentElement];
			if (!info || currentElement === "unknown" || currentElement === "mix") return;
			if (info.tool && !info.canPlace) return; // Werkzeuge nur beim Host
		}
		else if (type !== "right") return;
		let coords;
		try { coords = lineCoords(sx, sy, x, y); } catch (e) { return; }
		const now = performance.now();
		const W = client.W;
		let any = false;
		for (const [cx, cy] of coords) {
			if (outOfBounds(cx, cy)) continue;
			const col = pixelMap[cx];
			if (!col) continue;
			const p = col[cy];
			if (type === "left") {
				if (p && mode !== "replace") continue;
				if (p) p.del = true;
				const np = { x: cx, y: cy, start: 0, element: currentElement, temp: 20 };
				np.color = predictColor(np);
				col[cy] = np;
				currentPixels.push(np);
			}
			else {
				if (!p) continue;
				p.del = true;
				col[cy] = undefined;
			}
			client.pred.set(cy * W + cx, now);
			any = true;
		}
		if (any) lastPixelDraw = -1;
	}

	function predictColor(p) {
		try {
			const info = elements[p.element];
			if ((info.customColor || info.singleColor) && currentColorMap[p.element]) return pixelColorPick(p, currentColorMap[p.element]);
			return pixelColorPick(p);
		} catch (e) { return "rgb(255,255,255)"; }
	}

	function clientLoop() {
		if (mp.role !== "client") return;
		const now = performance.now();
		// Cursor senden
		const key = mousePos.x + "," + mousePos.y + "," + mouseSize + "," + currentElement;
		if (key !== client.lastCursor) {
			client.lastCursor = key;
			sendToHost({ t: "c", x: mousePos.x, y: mousePos.y, s: mouseSize, e: currentElement });
		}
		// Pause-Button wurde lokal gedrückt -> an Host weiterleiten
		// (manualPaused = Absicht des Spielers; "paused" ändern auch Menüs/Prompts)
		if (!!manualPaused !== client.hostPaused) {
			client.hostPaused = !!manualPaused;
			sendToHost({ t: "pause", v: client.hostPaused });
		}
		// Vorschau-Pixel, die der Host nicht bestätigt hat, nachfragen
		if (client.pred.size) {
			const limit = now - PREDICT_MS - mp.stats.ping;
			const ask = [];
			for (const [i, t] of client.pred) {
				if (t > limit) continue;
				ask.push(i);
				client.pred.delete(i);
				if (ask.length >= 20000) break;
			}
			if (ask.length) sendToHost({ t: "cells", l: ask });
		}
		if (now - client.lastPing > 2000) {
			client.lastPing = now;
			sendToHost({ t: "ping", ts: now });
		}
	}

	// Lokale Spiegel-Pixel in echte Sandboxels-Pixel umwandeln (nach Verlassen)
	function materializeMirror() {
		const list = [];
		for (let x = 0; x < pixelMap.length; x++) {
			const col = pixelMap[x];
			if (!col) continue;
			for (let y = 0; y < col.length; y++) {
				const p = col[y];
				if (p && !p.del) list.push(p);
			}
		}
		internal++;
		try {
			orig.clearAll();
			for (const p of list) {
				if (!elements[p.element] || p.element === "unknown") continue;
				orig.createPixel(p.element, p.x, p.y);
				const np = pixelMap[p.x] && pixelMap[p.x][p.y];
				if (np) { np.color = p.color; np.temp = p.temp; }
			}
		}
		finally { internal--; }
	}

	// ------------------------------------------------------------ leave / misc

	function leave() {
		const wasClient = mp.role === "client";
		const role = mp.role;
		mp.role = null;
		if (host.syncTimer) { clearInterval(host.syncTimer); host.syncTimer = null; }
		if (client.timer) { clearInterval(client.timer); client.timer = null; }
		for (const id in host.conns) { try { host.conns[id].conn.close(); } catch (e) { } }
		host.conns = {};
		if (client.conn) { try { client.conn.close(); } catch (e) { } client.conn = null; }
		if (mp.peer) { try { mp.peer.destroy(); } catch (e) { } mp.peer = null; }
		client.pred.clear();
		client.chunks = {};
		mp.players = {};
		mp.code = null;
		mp.stats.ping = 0;
		if (wasClient && hooksInstalled) materializeMirror();
		setBusy(false);
		if (role) log("Multiplayer beendet.");
		updatePanel();
	}

	window.addEventListener("beforeunload", () => { if (mp.peer) try { mp.peer.destroy(); } catch (e) { } });

	// ---------------------------------------------------------- remote cursors

	function drawRemoteCursors(ctx) {
		if (!mp.role) return;
		ctx.save();
		ctx.font = Math.max(10, Math.round(pixelSize * 1.8)) + "px sans-serif";
		ctx.textBaseline = "bottom";
		ctx.lineWidth = 2;
		for (const id in mp.players) {
			if (id === mp.myId) continue;
			const p = mp.players[id];
			if (p.x < 0 || p.y < 0) continue;
			const size = p.s || 1;
			const off = Math.trunc(size / 2);
			const px = (p.x - off) * pixelSize, py = (p.y - off) * pixelSize;
			ctx.globalAlpha = 0.9;
			ctx.strokeStyle = p.color;
			ctx.strokeRect(px, py, size * pixelSize, size * pixelSize);
			const label = p.name + (p.e ? " · " + p.e : "");
			const tw = ctx.measureText(label).width;
			ctx.globalAlpha = 0.65;
			ctx.fillStyle = "#000";
			ctx.fillRect(px, py - Math.round(pixelSize * 1.8) - 6, tw + 6, Math.round(pixelSize * 1.8) + 4);
			ctx.globalAlpha = 1;
			ctx.fillStyle = p.color;
			ctx.fillText(label, px + 3, py - 3);
		}
		ctx.restore();
	}

	// --------------------------------------------------------------------- UI

	let panel = null, statusEl = null, busy = false;

	function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
	function setBusy(v) { busy = v; updatePanel(); }

	function esc(s) { return String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }

	// Netzwerk-Anzeige (1x pro Sekunde)
	let lastStats = { sent: 0, recv: 0, syncs: 0, syncMs: 0 };
	function updateNetStats() {
		const s = mp.stats;
		const up = (s.sent - lastStats.sent) / 1024, down = (s.recv - lastStats.recv) / 1024;
		const syncs = s.syncs - lastStats.syncs;
		const syncMs = syncs ? (s.syncMs - lastStats.syncMs) / syncs : 0;
		lastStats = { sent: s.sent, recv: s.recv, syncs: s.syncs, syncMs: s.syncMs };
		const el = panel && panel.querySelector("#sbmpNet");
		if (!el) return;
		if (mp.role === "host") el.textContent = "Upload " + up.toFixed(0) + " KB/s · " + syncs + " Updates/s · Scan " + syncMs.toFixed(1) + " ms";
		else if (mp.role === "client") el.textContent = "Ping " + s.ping + " ms · Download " + down.toFixed(0) + " KB/s";
		else el.textContent = "";
	}

	function buildPanel() {
		const style = document.createElement("style");
		style.textContent = `
#multiplayerButton{position:fixed;top:10px;right:10px;z-index:10000;padding:6px 12px;background:#2a2a2a;color:#fff;border:2px solid #4da6ff;font:bold 14px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.5)}
#multiplayerButton:hover{background:#3a3a3a}
#sbmpPanel{position:fixed;top:48px;right:10px;z-index:9999;width:230px;background:rgba(20,20,20,.94);color:#fff;border:2px solid #555;font:13px Arial,sans-serif;padding:8px 10px;box-shadow:0 2px 10px rgba(0,0,0,.5);display:none}
#sbmpPanel h3{margin:0 0 6px;font-size:15px;display:flex;justify-content:space-between;align-items:center}
#sbmpPanel input{width:100%;box-sizing:border-box;margin:3px 0;padding:4px;background:#333;color:#fff;border:1px solid #666;font-size:13px}
#sbmpPanel button{width:100%;margin:3px 0;padding:5px;background:#444;color:#fff;border:1px solid #777;cursor:pointer;font-size:13px}
#sbmpPanel button:hover{background:#555}
#sbmpPanel button:disabled{opacity:.5;cursor:default}
#sbmpPanel .code{font-size:22px;letter-spacing:3px;text-align:center;background:#000;padding:4px;margin:4px 0;user-select:all;font-family:monospace}
#sbmpPanel ul{list-style:none;padding:0;margin:4px 0}
#sbmpPanel li{padding:1px 0}
#sbmpPanel .dot{display:inline-block;width:9px;height:9px;margin-right:5px;border-radius:50%}
#sbmpPanel .status{color:#aaa;font-size:11px;margin-top:5px;word-wrap:break-word}
#sbmpPanel .net{color:#8fd18f;font-size:11px;margin-top:3px}
#sbmpPanel .x{width:auto;margin:0;padding:0 6px;background:none;border:none;font-size:16px}
`;
		document.head.appendChild(style);
		panel = document.createElement("div");
		panel.id = "sbmpPanel";
		document.body.appendChild(panel);
		// Verhindert, dass Tastatureingaben im Panel Sandboxels-Shortcuts auslösen
		panel.addEventListener("keydown", e => e.stopPropagation());
		panel.addEventListener("keyup", e => e.stopPropagation());
		panel.addEventListener("keypress", e => e.stopPropagation());

		const btn = document.createElement("button");
		btn.id = "multiplayerButton";
		btn.title = "Multiplayer";
		btn.textContent = "Multiplayer";
		btn.onclick = () => { togglePanel(); };
		// Schwebend oben rechts, damit der Button immer sichtbar ist
		// (die Werkzeugleiste ist scrollbar und schneidet Buttons ab)
		document.body.appendChild(btn);
		updatePanel();
	}

	function togglePanel(show) {
		if (!panel) return;
		const vis = show !== undefined ? show : panel.style.display !== "block";
		panel.style.display = vis ? "block" : "none";
	}

	function updatePanel() {
		if (!panel) return;
		let html = `<h3>Multiplayer <button class="x" data-act="close" title="Schließen">×</button></h3>`;
		if (!mp.role) {
			html += `<label>Dein Name</label><input id="sbmpName" maxlength="20" value="${esc(mp.name)}">
<button data-act="host" ${busy ? "disabled" : ""}>Raum erstellen (Host)</button>
<input id="sbmpCode" placeholder="Raumcode" maxlength="10" style="text-transform:uppercase">
<button data-act="join" ${busy ? "disabled" : ""}>Beitreten</button>`;
		}
		else {
			html += `<div>${mp.role === "host" ? "Du bist Host. Raumcode:" : "Verbunden mit Raum:"}</div>
<div class="code" title="Code an Freunde schicken">${esc(mp.code || "")}</div>
<button data-act="copy">Code kopieren</button>
<div>Spieler (${Object.keys(mp.players).length}):</div><ul>`;
			for (const id in mp.players) {
				const p = mp.players[id];
				html += `<li><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${id === mp.myId ? " (du)" : ""}</li>`;
			}
			html += `</ul><button data-act="leave">${mp.role === "host" ? "Raum schließen" : "Verlassen"}</button>`;
		}
		html += `<div class="net" id="sbmpNet"></div>`;
		html += `<div class="status" id="sbmpStatus">${statusEl ? esc(statusEl.textContent) : ""}</div>`;
		panel.innerHTML = html;
		statusEl = panel.querySelector("#sbmpStatus");
		const nameIn = panel.querySelector("#sbmpName");
		if (nameIn) nameIn.onchange = () => { mp.name = nameIn.value.trim().slice(0, 20) || mp.name; localStorage.setItem("sbmp-name", mp.name); };
		const codeIn = panel.querySelector("#sbmpCode");
		if (codeIn) codeIn.onkeydown = (e) => { if (e.key === "Enter") panel.querySelector('[data-act="join"]').click(); };
		panel.querySelectorAll("[data-act]").forEach(b => {
			b.onclick = () => {
				const act = b.getAttribute("data-act");
				if (nameIn) { mp.name = nameIn.value.trim().slice(0, 20) || mp.name; localStorage.setItem("sbmp-name", mp.name); }
				if (act === "close") togglePanel(false);
				else if (act === "host") startHost();
				else if (act === "join") joinRoom(codeIn.value);
				else if (act === "leave") leave();
				else if (act === "copy") {
					try { navigator.clipboard.writeText(mp.code); setStatus("Code kopiert!"); } catch (e) { }
				}
			};
		});
	}

	// Raumcode über URL: ...?mpjoin=ABCDE
	function onGameReady() {
		if (document.getElementById("multiplayerButton")) return;
		buildPanel();
		try { logMessage("Multiplayer-Mod geladen - Button oben rechts"); } catch (e) { }
		try {
			const join = new URLSearchParams(location.search).get("mpjoin");
			if (join) setTimeout(() => { togglePanel(true); joinRoom(join); }, 500);
		} catch (e) { }
	}

	// Normalerweise laufen Mods vor window.onload. Wurde die Mod nachträglich
	// (z.B. über die Browser-Konsole) geladen, ist das Spiel schon fertig.
	if (document.readyState === "complete" && window.canvas) {
		onGameReady();
	}
	else if (typeof runAfterLoad === "function") {
		runAfterLoad(() => setTimeout(onGameReady, 0));
	}
	else {
		window.addEventListener("load", () => setTimeout(onGameReady, 0));
	}
})();
