// Sandboxels Multiplayer Mod
// Mehrere Spieler bearbeiten gleichzeitig dieselbe Welt.
//
// Funktionsweise (Host-autoritativ):
//  - Der Host simuliert die Welt ganz normal.
//  - Mitspieler (Clients) simulieren NICHT selbst. Ihre Maus-Aktionen
//    (Element, Pinselgröße, Linie von/bis ...) werden an den Host geschickt,
//    der sie mit den originalen Sandboxels-Funktionen ausführt.
//  - Der Host schickt ~20x pro Sekunde nur die geänderten Pixel (binär) an alle.
//  - Verbindung per WebRTC über PeerJS (öffentlicher Vermittlungsserver,
//    kein eigener Server nötig). Raumcode = Peer-ID des Hosts.

(function () {
	"use strict";

	const MP_VERSION = 1;
	const PEERJS_URL = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
	const ID_PREFIX = "sbmp-";
	const SYNC_MS = 50;            // Host -> Clients Pixel-Updates (20/s)
	const CURSOR_MS = 66;          // Cursor-Updates (~15/s)
	const TEMP_STEP = 3;           // Temperaturänderung ab der neu gesendet wird
	const MAX_REMOTE_SIZE = 150;   // max. Pinselgröße für Mitspieler
	const MAX_BUFFERED = 4 * 1024 * 1024; // Backpressure-Grenze pro Verbindung
	const REC = 13;                // Bytes pro Pixel-Datensatz
	const PLAYER_COLORS = ["#ff4d4d", "#4da6ff", "#5cff5c", "#ffd24d", "#ff66ff", "#4dffff", "#ff9933", "#b366ff"];

	const mp = window.sbMultiplayer = {
		role: null,       // null | "host" | "client"
		peer: null,
		name: localStorage.getItem("sbmp-name") || ("Spieler" + Math.floor(Math.random() * 900 + 100)),
		code: null,
		myId: null,
		players: {},      // id -> {id,name,color,x,y,s,e}
	};

	// ---------------------------------------------------------------- helpers

	function log(msg) {
		try { logMessage("[MP] " + msg); } catch (e) { console.log("[MP] " + msg); }
		setStatus(msg);
	}

	function loadPeerJS() {
		return new Promise((resolve, reject) => {
			if (window.Peer) return resolve();
			const s = document.createElement("script");
			s.src = PEERJS_URL;
			s.onload = () => resolve();
			s.onerror = () => reject(new Error("PeerJS konnte nicht geladen werden"));
			document.head.appendChild(s);
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

		renderPostPixel(drawRemoteCursors);
	}

	// ------------------------------------------------------------------- host

	const host = {
		conns: {},        // peerId -> {conn, player, needsFull, lastPlace}
		elemIds: {},      // name -> id (1..)
		elemNames: [null],
		prevE: null, prevC: null, prevF: null, prevA: null, prevT: null,
		W: 0, H: 0,
		buf: null, view: null,
		syncTimer: null,
		lastPaused: null,
		lastBorder: null,
		cursorTick: 0,
	};

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
					host.syncTimer = setInterval(hostSync, SYNC_MS);
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
		conn.on("open", () => { });
		conn.on("data", (msg) => {
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
				conn.send({ t: "err", m: "Andere Mod-Version (Host: " + MP_VERSION + ")" });
				setTimeout(() => conn.close(), 500);
				return;
			}
			const used = Object.values(mp.players).map(p => p.color);
			const color = PLAYER_COLORS.find(col => used.indexOf(col) === -1) || PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
			const player = { id: conn.peer, name: String(msg.name || "Spieler").slice(0, 20), color: color, x: -100, y: -100, s: 1, e: "" };
			host.conns[conn.peer] = { conn: conn, player: player, needsFull: true, lastPlace: -100 };
			mp.players[conn.peer] = player;
			conn.send({
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
		}
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
		host.buf = new ArrayBuffer(n * REC);
		host.view = new DataView(host.buf);
		for (const id in host.conns) host.conns[id].needsFull = true;
	}

	function writeRec(v, o, idx, e, c, f, a, t) {
		v.setUint32(o, idx, true);
		v.setUint16(o + 4, e, true);
		v.setUint8(o + 6, (c >> 16) & 255);
		v.setUint8(o + 7, (c >> 8) & 255);
		v.setUint8(o + 8, c & 255);
		v.setUint8(o + 9, f);
		v.setUint8(o + 10, a);
		v.setInt16(o + 11, t, true);
	}

	function hostSync() {
		if (mp.role !== "host") return;
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

		const connIds = Object.keys(host.conns);
		const W = host.W, H = host.H;
		const pE = host.prevE, pC = host.prevC, pF = host.prevF, pA = host.prevA, pT = host.prevT;
		const v = host.view;
		let o = 0;
		let total = 0;
		for (let x = 0; x < W; x++) {
			const col = pixelMap[x];
			for (let y = 0; y < H; y++) {
				const i = y * W + x;
				let p = col ? col[y] : undefined;
				if (!p || p.del) {
					if (pE[i] !== 0) {
						pE[i] = 0;
						writeRec(v, o, i, 0, 0, 0, 0, 0); o += REC;
					}
					continue;
				}
				total++;
				if (p.con && elements[p.element] && elements[p.element].canContain === true && elements[p.con.element]) p = p.con;
				const e = elemId(p.element);
				const c = colorToInt(p.color);
				const f = pixelFlags(p);
				const a = p.alpha === undefined ? 255 : Math.max(0, Math.min(254, Math.round(p.alpha * 254)));
				let t = Math.round(p.temp);
				if (!(t === t)) t = 20;
				if (t > 32767) t = 32767; else if (t < -32768) t = -32768;
				if (e !== pE[i] || c !== pC[i] || f !== pF[i] || a !== pA[i] || Math.abs(t - pT[i]) >= TEMP_STEP) {
					pE[i] = e; pC[i] = c; pF[i] = f; pA[i] = a; pT[i] = t;
					writeRec(v, o, i, e, c, f, a, t); o += REC;
				}
			}
		}

		// Cursor des Hosts aktualisieren
		const me = mp.players[mp.myId];
		if (me) { me.x = mousePos.x; me.y = mousePos.y; me.s = mouseSize; me.e = currentElement; }

		if (!connIds.length) return;
		const diff = o > 0 ? host.buf.slice(0, o) : null;
		let full = null;
		for (const id of connIds) {
			const c = host.conns[id];
			const dc = c.conn.dataChannel;
			if (!c.conn.open) continue;
			if (dc && dc.bufferedAmount > MAX_BUFFERED) { c.needsFull = true; continue; }
			if (c.needsFull) {
				if (!full) full = buildFull(total);
				c.conn.send({ t: "d", f: 1, k: pixelTicks, b: full });
				c.needsFull = false;
			}
			else if (diff) {
				c.conn.send({ t: "d", f: 0, k: pixelTicks, b: diff });
			}
		}
		host.cursorTick += SYNC_MS;
		if (host.cursorTick >= 100) {
			host.cursorTick = 0;
			broadcast({ t: "cur", l: Object.values(mp.players).map(p => [p.id, p.x, p.y, p.s, p.e]) });
		}
	}

	// Kompletter Zustand aus den prev-Arrays (die gerade aktualisiert wurden)
	function buildFull(count) {
		const buf = new ArrayBuffer(count * REC);
		const v = new DataView(buf);
		const pE = host.prevE, pC = host.prevC, pF = host.prevF, pA = host.prevA, pT = host.prevT;
		let o = 0;
		for (let i = 0; i < pE.length && o < buf.byteLength; i++) {
			if (pE[i] === 0) continue;
			writeRec(v, o, i, pE[i], pC[i], pF[i], pA[i], pT[i]); o += REC;
		}
		return o === buf.byteLength ? buf : buf.slice(0, o);
	}

	function broadcast(msg) {
		for (const id in host.conns) {
			const c = host.conns[id];
			if (c.conn.open) c.conn.send(msg);
		}
	}

	function broadcastPlayers() {
		broadcast({ t: "players", l: Object.values(mp.players).map(p => ({ id: p.id, name: p.name, color: p.color })) });
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
				const conn = peer.connect(ID_PREFIX + code, { reliable: true });
				client.conn = conn;
				const timeout = setTimeout(() => {
					if (mp.role !== "client") { log("Keine Antwort vom Host."); leave(); }
				}, 15000);
				conn.on("open", () => {
					conn.send({ t: "hello", name: mp.name, v: MP_VERSION });
				});
				conn.on("data", (msg) => {
					if (msg && msg.t === "welcome") clearTimeout(timeout);
					try { handleClientMessage(msg); }
					catch (err) { console.error("[MP] Fehler bei Nachricht", msg, err); }
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
		if (mp.role === "client" && client.conn && client.conn.open) client.conn.send(msg);
	}

	function applyHostSize() {
		internal++;
		try {
			const ps = pixelSize;
			orig.resizeCanvas(client.H * ps, client.W * ps, ps, true, true);
		}
		finally { internal--; }
		currentPixels = [];
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
					const p = mp.players[id];
					if (p) { p.x = x; p.y = y; p.s = s; p.e = e; }
				}
				lastPixelDraw = -1;
				break;
			case "d":
				applyDiff(msg.b, msg.f === 1);
				if (typeof msg.k === "number") pixelTicks = msg.k;
				lastPixelDraw = -1; // neu zeichnen
				break;
		}
	}

	function setHostPaused(v) {
		client.hostPaused = !!v;
		paused = client.hostPaused;
		manualPaused = paused;
		try { checkPause(); } catch (e) { }
	}

	function applyDiff(buffer, isFull) {
		if (!buffer) return;
		if (buffer.buffer) buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
		const W = client.W;
		if (isFull) {
			currentPixels = [];
			for (let x = 0; x < pixelMap.length; x++) {
				const col = pixelMap[x];
				if (col) for (let y = 0; y < col.length; y++) col[y] = undefined;
			}
		}
		const v = new DataView(buffer);
		const n = Math.floor(buffer.byteLength / REC);
		for (let k = 0; k < n; k++) {
			const o = k * REC;
			const idx = v.getUint32(o, true);
			const x = idx % W, y = (idx - x) / W;
			const col = pixelMap[x];
			if (!col) continue;
			const e = v.getUint16(o + 4, true);
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
			p.color = intToColor((v.getUint8(o + 6) << 16) | (v.getUint8(o + 7) << 8) | v.getUint8(o + 8));
			const f = v.getUint8(o + 9);
			if (f & 1) p.charge = 1; else delete p.charge;
			if (f & 2) p.burning = true; else delete p.burning;
			if (f & 4) p.glow = true; else if (f & 8) p.glow = false; else delete p.glow;
			if (f & 16) p.flipX = true; else delete p.flipX;
			if (f & 32) p.flipY = true; else delete p.flipY;
			const r = (f >> 6) & 3;
			if (r) p.r = r; else delete p.r;
			const a = v.getUint8(o + 10);
			if (a === 255) delete p.alpha; else p.alpha = a / 254;
			p.temp = v.getInt16(o + 11, true);
		}
	}

	function clientLoop() {
		if (mp.role !== "client") return;
		// Cursor senden
		const key = mousePos.x + "," + mousePos.y + "," + mouseSize + "," + currentElement;
		if (key !== client.lastCursor) {
			client.lastCursor = key;
			sendToHost({ t: "c", x: mousePos.x, y: mousePos.y, s: mouseSize, e: currentElement });
			const me = mp.players[mp.myId];
			if (me) { me.x = mousePos.x; me.y = mousePos.y; me.s = mouseSize; }
		}
		// Pause-Button wurde lokal gedrückt -> an Host weiterleiten
		// (manualPaused = Absicht des Spielers; "paused" ändern auch Menüs/Prompts)
		if (!!manualPaused !== client.hostPaused) {
			client.hostPaused = !!manualPaused;
			sendToHost({ t: "pause", v: client.hostPaused });
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
		mp.players = {};
		mp.code = null;
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

	function buildPanel() {
		const style = document.createElement("style");
		style.textContent = `
#sbmpPanel{position:fixed;top:10px;right:10px;z-index:9999;width:230px;background:rgba(20,20,20,.94);color:#fff;border:2px solid #555;font:13px Arial,sans-serif;padding:8px 10px;box-shadow:0 2px 10px rgba(0,0,0,.5);display:none}
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
		btn.className = "controlButton";
		btn.title = "Multiplayer";
		btn.textContent = "Multiplayer";
		btn.onclick = () => { togglePanel(); };
		const tc = document.getElementById("toolControls");
		if (tc) tc.appendChild(btn);
		else { btn.style.cssText = "position:fixed;bottom:10px;right:10px;z-index:9999"; document.body.appendChild(btn); }
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
		buildPanel();
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
