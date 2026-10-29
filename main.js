import { createNetwork } from './network.js';

(async () => {
    const app = new PIXI.Application();

    await app.init({
        resizeTo: window,
        background: '#16213e',
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
    });

    document.body.appendChild(app.canvas);

    // A cell holds a unit or nothing. The server sends a flat list of units;
    // these two grids are that list laid out by cell, [side][col][row], where
    // col 1 is the front line next to the middle of the board. Our side is
    // always the left one.
    const leftT = [
        [null, null, null, null, null],
        [null, null, null, null, null]
    ];

    const rightT = [
        [null, null, null, null, null],
        [null, null, null, null, null]
    ];

    const leftSquares = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0]
    ];
    const rightSquares = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0]
    ];

    const grids = [leftT, rightT];
    const squareSets = [leftSquares, rightSquares];

    // Our side is blue, the other one red, and a shot keeps the colour of the
    // side it came from.
    const SIDE_COLOR = [0x3d7dd8, 0xd8503d];
    const TRAIL_COLOR = [0x4aa3ff, 0xff5a4a];
    const EMPTY_COLOR = 0x1b2744;
    const SELECT_COLOR = 0xffe680;

    // The two units the player commands are the same side in a paler blue: the
    // ally's three keep the normal one. The whole mark is the colour of the
    // tile, because a bar or a badge would fight for room with the role glyph
    // and the health bar that already sit there.
    const MINE_COLOR = 0x62b0f0;

    // Everything below is created once and positioned by layout(). Nothing keeps
    // a position or a size that was computed at startup, because that is what
    // used to desync the panels from the squares after a resize.
    const rect = new PIXI.Graphics();
    const panel1 = new PIXI.Graphics();
    const panel2 = new PIXI.Graphics();
    const circle = new PIXI.Graphics();
    const ordersGfx = new PIXI.Graphics();
    const shotsGfx = new PIXI.Graphics();

    // Taps are caught here, on one invisible layer over the whole board, and
    // turned into a cell or the button by arithmetic. It is not the obvious
    // way round - each tile could carry its own handler - but a filled
    // Graphics stopped answering hit tests in Pixi 8.22 (its containsPoint now
    // asks the graphics context, which says no), so the board looked perfect
    // and ignored every click. A Container with an explicit hitArea still
    // works, and one layer also keeps the mapping in a single place.
    const tapLayer = new PIXI.Container();
    tapLayer.eventMode = 'static';
    tapLayer.hitArea = new PIXI.Rectangle(0, 0, 1, 1);

    const statusText = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    statusText.anchor.set(0.5);

    const hintText = new PIXI.Text({
        text: 'новый бой',
        style: { fontFamily: 'monospace', fill: 0xffffff },
    });
    hintText.anchor.set(0, 0.5);

    // One line about orders, in the thin band between the panels and the bottom
    // strip. It doubles as the reply to a refused order, so the player always
    // learns why nothing happened instead of guessing.
    const orderHint = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff },
    });
    orderHint.anchor.set(0.5, 0.5);

    // Two scenes over one canvas: the lobby and the board. Only one is visible
    // at a time, so the lobby is drawn with the same toolkit and palette as the
    // board instead of being an HTML layer that never quite matches it.
    const boardScene = new PIXI.Container();
    const lobbyScene = new PIXI.Container();

    const lobbyTitle = new PIXI.Text({
        text: 'ЛОББИ',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    lobbyTitle.anchor.set(0.5, 0);

    const titleUnderline = new PIXI.Graphics();

    const createBtn = new PIXI.Graphics();
    const createBtnText = new PIXI.Text({
        text: 'Создать комнату',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    createBtnText.anchor.set(0.5, 0.5);

    const lobbyMsg = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff },
    });
    lobbyMsg.anchor.set(0.5, 0.5);

    const lobbyCards = new PIXI.Container();

    // The button that takes a player back out of a room, part of the board scene.
    const leaveBtn = new PIXI.Graphics();
    const leaveBtnText = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff },
    });
    leaveBtnText.anchor.set(0.5, 0.5);

    // Hit-test rectangles, filled by layoutLobby()/renderLobby() and read by the
    // tap layer. They are plain data for the same reason the board routes taps
    // through arithmetic rather than per-shape handlers.
    let createRect = null;
    let leaveRect = null;
    let cardRects = [];
    let cardObjects = [];
    let canCreate = true;
    let hoverCreate = false;
    let hoverCard = -1;

    // Side of one square, in screen pixels. drawCell() needs it, and layout()
    // recomputes it on every resize.
    let sqX = 0;

    function drawCell(g, unit, side) {
        g.clear();

        if (!unit) {
            g.roundRect(0, 0, sqX, sqX, sqX * 0.08).fill(EMPTY_COLOR);
            return;
        }

        // A tile whose unit answers to the player is painted in the paler blue.
        // Most of our line is an ally fighting on its own, and without the tint
        // there is no way to tell which taps do anything until one is refused.
        const mine = side === 0 && canCommand(unit);
        g.roundRect(0, 0, sqX, sqX, sqX * 0.08).fill(mine ? MINE_COLOR : SIDE_COLOR[side]);

        // The unit the player has picked to command. Drawn as a ring inside the
        // tile so the tile itself keeps the colour of its side.
        if (side === 0 && unit.id === selected) {
            const inset = Math.max(1.5, sqX * 0.05);
            g.roundRect(inset, inset, sqX - inset * 2, sqX - inset * 2, sqX * 0.05)
                .stroke({ width: Math.max(2, sqX * 0.045), color: SELECT_COLOR, alpha: 0.95 });
        }

        // Role as a glyph rather than a different cell shape: the board is the
        // same 2x5 as before, and a melee unit and a ranged one differ by what
        // stands on the tile. A square is a melee unit, a diamond is a ranged
        // one. The column already tells the player which line it is in.
        const cx = sqX * 0.5;
        const cy = sqX * 0.42;
        const r = sqX * (unit.role === 'ranged' ? 0.17 : 0.15);

        if (unit.role === 'ranged') {
            g.poly([cx, cy - r, cx + r, cy, cx, cy + r, cx - r, cy])
                .fill({ color: 0xffffff, alpha: 0.8 });
        }
        else {
            g.rect(cx - r, cy - r, r * 2, r * 2)
                .fill({ color: 0xffffff, alpha: 0.8 });
        }

        // Health as a bar along the bottom: it is the only number on the board
        // for now, and a bar reads faster than a number would.
        const pad = sqX * 0.12;
        const barH = Math.max(3, sqX * 0.12);
        const barW = sqX - pad * 2;
        const barY = sqX - pad - barH;

        const frac = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
        g.rect(pad, barY, barW, barH).fill(0x0d1526);

        if (frac > 0) {
            const color = frac > 0.5 ? 0x51cf66 : frac > 0.25 ? 0xffd43b : 0xff6b6b;
            g.rect(pad, barY, barW * frac, barH).fill(color);
        }
    }

    function redrawBoard() {
        for (let side = 0; side < 2; side++) {
            for (let j = 0; j < 2; j++) {
                for (let i = 0; i < 5; i++) {
                    drawCell(squareSets[side][j][i], grids[side][j][i], side);
                }
            }
        }
    }

    function layout() {
        const w = app.screen.width;
        const h = app.screen.height;

        rect.clear()
            .rect(0.02 * w, 0.85 * h, 0.96 * w, 0.1 * h)
            .fill(0xe94560);

        panel1.clear()
            .rect(0.05 * w, 0.02 * h, 0.4 * w, 0.8 * h)
            .fill(0xe94560);

        panel2.clear()
            .rect(0.55 * w, 0.02 * h, 0.4 * w, 0.8 * h)
            .fill(0xe94560);

        const sizeY = 0.8 * h;
        const borderIndentY = 0.03 * h;
        const sqIndentX = 0.02 * w;
        const sqIndentY = 0.02 * h;

        // Squares are sized by height, as before. The extra ceiling keeps the
        // two columns inside a panel in a narrow window: 0.34w is the panel's
        // inner width and 0.02w is the single gap between the columns. On a
        // typical landscape screen the height rule is smaller and wins, so the
        // usual look is unchanged.
        const byHeight = (sizeY - borderIndentY * 2 - sqIndentY * 4) / 5;
        const byWidth = (0.34 * w - 0.02 * w) / 2;
        sqX = Math.max(1, Math.min(byHeight, byWidth));
        tapLayer.hitArea.width = w;
        tapLayer.hitArea.height = h;

        for (let j = 0; j < 2; j++) {
            for (let i = 0; i < 5; i++) {
                const left = leftSquares[j][i];
                left.x = 0.08 * w + sqX * j + sqIndentX * j;
                left.y = 0.05 * h + sqX * i + sqIndentY * i;

                const right = rightSquares[j][i];
                right.x = w - sqX - (0.08 * w + sqX * j + sqIndentX * j);
                right.y = 0.05 * h + sqX * i + sqIndentY * i;
            }
        }

        // A resize wipes the squares, so they are redrawn at the new size with
        // whatever the board currently holds.
        redrawBoard();

        circle.clear()
            .circle(0, 0, 0.05 * h)
            .fill(0x2ecc71);
        circle.x = 0.1 * w;
        circle.y = 0.9 * h;

        hintText.style.fontSize = Math.round(0.045 * h);
        hintText.x = 0.16 * w;
        hintText.y = 0.9 * h;

        orderHint.style.fontSize = Math.max(9, Math.round(0.028 * h));
        orderHint.x = 0.5 * w;
        orderHint.y = 0.838 * h;

        statusText.style.fontSize = Math.round(0.055 * h);
        statusText.x = 0.62 * w;
        statusText.y = 0.9 * h;

        layoutLobby();

        // A resize also re-lays the cards; they are positioned from the screen,
        // not from a stored size, so they have to be rebuilt at the new size.
        if (screen === 'lobby' && lastLobby) {
            renderLobby(lastLobby.rooms, lastLobby.max);
        }
    }

    // Positions the lobby scene. Called from layout() on every resize, and its
    // card slots are recomputed in renderLobby() from the current screen.
    function layoutLobby() {
        const w = app.screen.width;
        const h = app.screen.height;

        lobbyTitle.style.fontSize = Math.round(0.075 * h);
        lobbyTitle.x = 0.5 * w;
        lobbyTitle.y = 0.10 * h;
        titleUnderline.clear()
            .rect(0.5 * w - 0.09 * w, 0.10 * h + lobbyTitle.height + 0.015 * h,
                  0.18 * w, Math.max(2, Math.round(0.008 * h)))
            .fill(0xe94560);

        const bw = Math.min(0.5 * w, 380);
        const bh = Math.round(0.09 * h);
        createRect = { x: (w - bw) / 2, y: 0.24 * h, w: bw, h: bh };
        createBtnText.style.fontSize = Math.round(0.035 * h);
        createBtnText.x = 0.5 * w;
        createBtnText.y = 0.24 * h + bh / 2;

        lobbyMsg.style.fontSize = Math.round(0.028 * h);
        lobbyMsg.x = 0.5 * w;
        lobbyMsg.y = 0.24 * h + bh + 0.022 * h;

        const lw = Math.round(0.16 * w);
        const lh = Math.round(0.06 * h);
        leaveRect = { x: 0.02 * w, y: 0.02 * h, w: lw, h: lh };
        leaveBtnText.style.fontSize = Math.round(0.026 * h);
        leaveBtnText.x = 0.02 * w + lw / 2;
        leaveBtnText.y = 0.02 * h + lh / 2;

        paintLobby();
    }

    boardScene.addChild(rect);
    boardScene.addChild(panel1);
    boardScene.addChild(panel2);

    // A cell is also the board's only control, but the handlers live on the tap
    // layer above, not on the tiles: see tapLayer.
    for (const side of [0, 1]) {
        for (let j = 0; j < 2; j++) {
            for (let i = 0; i < 5; i++) {
                const square = new PIXI.Graphics();
                squareSets[side][j][i] = square;
                boardScene.addChild(square);
            }
        }
    }

    // Above the squares: a shot is drawn between two of them, and under it the
    // dotted line that shows which unit is under orders and against whom.
    boardScene.addChild(ordersGfx);
    boardScene.addChild(shotsGfx);
    boardScene.addChild(statusText);
    boardScene.addChild(hintText);
    boardScene.addChild(orderHint);
    boardScene.addChild(circle);
    boardScene.addChild(leaveBtn);
    boardScene.addChild(leaveBtnText);

    lobbyScene.addChild(lobbyTitle);
    lobbyScene.addChild(titleUnderline);
    lobbyScene.addChild(createBtn);
    lobbyScene.addChild(createBtnText);
    lobbyScene.addChild(lobbyMsg);
    lobbyScene.addChild(lobbyCards);

    app.stage.addChild(boardScene);
    app.stage.addChild(lobbyScene);
    app.stage.addChild(tapLayer);

    // The login form covers both scenes until the player is authenticated.
    boardScene.visible = false;
    lobbyScene.visible = false;

    tapLayer.on('pointerdown', onTap);
    // A hint that something is clickable, from the same arithmetic as the tap.
    tapLayer.on('pointermove', (e) => {
        const x = e.global.x;
        const y = e.global.y;
        let over = false;

        if (screen === 'lobby') {
            const nc = createHit(x, y);
            const ni = cardHit(x, y);
            if (nc !== hoverCreate || ni !== hoverCard) {
                hoverCreate = nc;
                hoverCard = ni;
                paintLobby();
            }
            over = nc || ni >= 0;
        } else {
            over = leaveHit(x, y) || overCircle(x, y) || cellAt(x, y);
        }

        app.canvas.style.cursor = over ? 'pointer' : 'default';
    });

    // Highest sequence number shown so far. Broadcasts are not ordered — two
    // threads can deliver snapshots in the opposite order — so anything not
    // newer than this is a state the board has already moved past.
    let lastSeq = 0;

    // Which scene the page shows: the login form, the lobby, or a room. roomId
    // 0 means not in a room; the login overlay, lobbyScene and boardScene swap
    // to match.
    let screen = 'login';
    let roomId = 0;

    // Who is logged in, and whether the current room belongs to them. A spectator
    // sees the same board but cannot order or restart.
    let myName = '';
    let amOwner = false;
    let roomOwnerName = '';

    // The last lobby list shown, kept so a resize can re-render the cards at the
    // new size without asking the server again.
    let lastLobby = null;

    // Our own copy of the battle clock, in milliseconds since the battle began.
    // It runs every frame, so a shot can be drawn between two snapshots instead
    // of jumping 50 ms at a time; each snapshot nudges it back towards the
    // server's time.
    let battleT = 0;
    let shots = [];
    let running = false;

    // The unit of ours the player has picked (0 = none), the orders the server
    // reports as being in force, and the living units by id - an order is just
    // two ids, so a cell has to be found from one.
    let selected = 0;
    let orders = [];
    const unitsById = new Map();

    // The ids the server says are the owner's to command. Our side is not all
    // ours: the rest of the line is an ally that fights by itself. Null means
    // the server did not say - an older build - and then every unit of ours is
    // treated as commandable. Only the room's owner commands at all, so a
    // spectator never sees the pale mark.
    let yours = null;

    function canCommand(unit) {
        if (!amOwner) return false;
        return yours === null || yours.has(unit.id);
    }

    // The reply to the last tap, shown for a moment instead of the standing
    // hint, so a refused order never looks like a click that got lost.
    let flashText = '';
    let flashUntil = 0;
    let flashTimer = 0;

    const net = createNetwork(
        'wss://clickerbase.ru:9000',
        handleServerMessage,
        // A restarted server counts from 1 again, a room membership lives in the
        // connection, and a login survives only while its token is known to the
        // server. On every open the client forgets the board and re-authenticates
        // with its stored token; being back in its room then follows the login.
        () => {
            lastSeq = 0;
            battleT = 0;
            selected = 0;

            const token = localStorage.getItem('fen_token');
            if (token) net.send({ action: 'login', token });
        },
    );

    // --- login --------------------------------------------------------------
    const loginEl = document.getElementById('login');
    const loginName = document.getElementById('loginName');
    const loginPassword = document.getElementById('loginPassword');
    const loginBtn = document.getElementById('loginBtn');
    const registerBtn = document.getElementById('registerBtn');
    const loginMsg = document.getElementById('loginMsg');

    function setLoginMsg(text) {
        loginMsg.textContent = text;
    }

    function showLogin() {
        screen = 'login';
        amOwner = false;
        boardScene.visible = false;
        lobbyScene.visible = false;
        loginEl.style.display = 'flex';
    }

    function submitAuth(kind) {
        const name = loginName.value.trim();
        const password = loginPassword.value;
        if (!name) { setLoginMsg('введи имя'); return; }
        if (password.length < 4) { setLoginMsg('пароль — минимум 4 символа'); return; }
        setLoginMsg('');
        loginPassword.value = '';
        net.send({ action: kind, name, password });
    }

    loginBtn.addEventListener('click', () => submitAuth('login'));
    registerBtn.addEventListener('click', () => submitAuth('register'));
    loginName.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginPassword.focus(); });
    loginPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth('login'); });

    function applyLoginResult(data) {
        if (data.ok) {
            localStorage.setItem('fen_token', data.token);
            localStorage.setItem('fen_name', data.name);
            myName = data.name;
            setLoginMsg('');

            if (screen === 'room' && roomId) {
                // A reconnect while in a room: back in after the token is accepted.
                net.send({ action: 'join_room', roomId });
            } else {
                showLobby();
            }
        } else {
            showLogin();
            setLoginMsg({
                taken: 'это имя уже занято',
                'bad-credentials': 'неверное имя или пароль',
                'bad-token': 'сессия истекла — войди заново',
                'weak-password': 'пароль — минимум 4 символа',
                'bad-request': 'сервер не понял запрос',
            }[data.reason] || 'не получилось войти');
        }
    }

    // --- lobby / rooms -----------------------------------------------------
    function plural(n, one, few, many) {
        const m10 = n % 10;
        const m100 = n % 100;
        if (m10 === 1 && m100 !== 11) return one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
        return many;
    }

    function statusLabel(status) {
        return status === 'running' ? 'бой идёт' : 'бой окончен';
    }

    function inRect(x, y, r) {
        return r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    }

    function createHit(x, y) { return canCreate && inRect(x, y, createRect); }
    function leaveHit(x, y) { return inRect(x, y, leaveRect); }
    function cardHit(x, y) {
        for (let i = 0; i < cardRects.length; i++) {
            if (inRect(x, y, cardRects[i])) return i;
        }
        return -1;
    }

    function setLobbyMsg(text) {
        lobbyMsg.text = text;
    }

    // Repaints the hover-sensitive fills: the create button, the leave button
    // and every card. Called on hover changes and after a re-render, never from
    // the ticker — a background tab must not depend on a frame to look right.
    function paintLobby() {
        if (createRect) {
            const color = canCreate ? (hoverCreate ? 0xff5d78 : 0xe94560) : 0x6b2b3e;
            createBtn.clear()
                .roundRect(createRect.x, createRect.y, createRect.w, createRect.h,
                           Math.min(14, createRect.h * 0.3))
                .fill(color);
            createBtnText.alpha = canCreate ? 1 : 0.5;
        }

        if (leaveRect) {
            leaveBtn.clear()
                .roundRect(leaveRect.x, leaveRect.y, leaveRect.w, leaveRect.h,
                           Math.min(10, leaveRect.h * 0.3))
                .fill(0xe94560);
        }

        for (let i = 0; i < cardObjects.length; i++) {
            const r = cardRects[i];
            cardObjects[i].g.clear()
                .roundRect(r.x, r.y, r.w, r.h, Math.min(10, r.h * 0.3))
                .fill(hoverCard === i ? 0xff5d78 : 0xe94560);
        }
    }

    function renderLobby(rooms, max) {
        lastLobby = { rooms, max };

        lobbyCards.removeChildren().forEach((c) => c.destroy(true));
        cardObjects = [];
        cardRects = [];
        hoverCard = -1;

        const w = app.screen.width;
        const h = app.screen.height;

        if (!rooms.length) {
            const empty = new PIXI.Text({
                text: 'комнат пока нет — создай первую',
                style: { fontFamily: 'monospace', fill: 0xffffff, fontSize: Math.round(0.03 * h) },
            });
            empty.anchor.set(0.5, 0.5);
            empty.x = 0.5 * w;
            empty.y = 0.62 * h;
            lobbyCards.addChild(empty);
            canCreate = true;
            paintLobby();
            return;
        }

        const cardW = Math.min(0.62 * w, 520);
        const gap = Math.round(0.014 * h);
        const listTop = 0.42 * h;
        const listBottom = 0.95 * h;
        const count = rooms.length;
        const cardH = Math.min(Math.round(0.055 * h),
                              Math.floor((listBottom - listTop - gap * (count - 1)) / count));
        const x = (w - cardW) / 2;
        let y = listTop;

        for (const room of rooms) {
            const g = new PIXI.Graphics();
            const name = new PIXI.Text({
                text: room.name,
                style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold', fontSize: Math.round(0.034 * h) },
            });
            name.anchor.set(0, 0.5);
            const meta = new PIXI.Text({
                text: statusLabel(room.status) + ' · ' + (room.owner || '?')
                    + ' · ' + room.players + ' ' + plural(room.players, 'игрок', 'игрока', 'игроков'),
                style: { fontFamily: 'monospace', fill: 0xffffff, fontSize: Math.round(0.028 * h) },
            });
            meta.anchor.set(1, 0.5);
            meta.alpha = 0.85;

            name.x = x + cardW * 0.05;
            name.y = y + cardH / 2;
            meta.x = x + cardW * 0.95;
            meta.y = y + cardH / 2;

            lobbyCards.addChild(g, name, meta);
            cardObjects.push({ g, name, meta });
            cardRects.push({ x, y, w: cardW, h: cardH, id: room.id });

            y += cardH + gap;
        }

        canCreate = rooms.length < max;
        paintLobby();
    }

    function clearBoardState() {
        lastSeq = 0;
        battleT = 0;
        selected = 0;
        shots = [];
        orders = [];
        yours = null;
        running = false;
        unitsById.clear();
        for (const column of leftT) column.fill(null);
        for (const column of rightT) column.fill(null);
        shotsGfx.clear();
        ordersGfx.clear();
    }

    function showLobby() {
        screen = 'lobby';
        roomId = 0;
        amOwner = false;
        roomOwnerName = '';
        clearBoardState();
        statusText.text = '';
        loginEl.style.display = 'none';
        boardScene.visible = false;
        lobbyScene.visible = true;
        redrawBoard();
        updateOrderHint();
    }

    function enterRoom(id, owner, ownerName) {
        screen = 'room';
        roomId = id;
        amOwner = !!owner;
        roomOwnerName = ownerName || '';
        clearBoardState();
        leaveBtnText.text = '← Комната ' + id;
        circle.visible = amOwner;
        loginEl.style.display = 'none';
        boardScene.visible = true;
        lobbyScene.visible = false;
        redrawBoard();
        updateOrderHint();
    }

    function applyRoomResult(data) {
        if (data.ok && data.roomId) {
            enterRoom(data.roomId, data.owner, data.ownerName);
            return;
        }

        // A refused join/create lands back in the lobby with the reason as text.
        showLobby();
        setLobbyMsg({
            full: 'все 10 комнат заняты — попробуй позже',
            'no-room': 'эта комната уже исчезла',
            'no-auth': 'войди, чтобы играть',
            'bad-request': 'сервер не понял запрос',
        }[data.reason] || 'не получилось войти');
    }

    function handleServerMessage(data) {
        console.log('Сервер прислал:', data);

        if (data.action === 'battle') {
            applyBattle(data);
        }
        else if (data.action === 'order_result') {
            applyOrderResult(data);
        }
        else if (data.action === 'login_result') {
            applyLoginResult(data);
        }
        else if (data.action === 'lobby') {
            // An anonymous client is also in the lobby and gets this list; render
            // it so it is ready, but only show the lobby once logged in. Before
            // that the login form stays on top.
            renderLobby(data.rooms || [], data.max);
            if (myName) showLobby();
        }
        else if (data.action === 'room_result') {
            applyRoomResult(data);
        }
        else if (data.action === 'state') {
            // The older server (the binary kept as server.prev) still sends the
            // plain 0/1 board. Kept so a rollback does not blank the page; it
            // can go once nothing can be rolled back to.
            applyLegacyState(data);
        }
    }

    function applyBattle(data) {
        // Battle frames belong to a room; a frame that straggles in after
        // leaving must not repaint the (hidden) board or advance the clock.
        if (screen !== 'room') return;

        if (typeof data.seq === 'number') {
            if (data.seq <= lastSeq) {
                console.log('Ignoring stale state, seq', data.seq, '<=', lastSeq);
                return;
            }
            lastSeq = data.seq;
        }

        for (const column of leftT) column.fill(null);
        for (const column of rightT) column.fill(null);
        unitsById.clear();

        for (const unit of data.units) {
            const grid = unit.side === 0 ? leftT : rightT;
            if (unit.col < 0 || unit.col > 1 || unit.row < 0 || unit.row > 4) continue;
            grid[unit.col][unit.row] = unit;
            unitsById.set(unit.id, unit);
        }

        // A new battle starts its clock at zero, and unit ids restart at 1 with
        // it. The pick has to be dropped here, before the board is drawn: the
        // same number in the new fight is a different unit, so keeping it would
        // put the ring on somebody else and send the next order to them.
        const drift = data.t - battleT;
        const newBattle = Math.abs(drift) > 250;
        if (newBattle) selected = 0;

        // A unit that died cannot stay picked: its id is gone from the snapshot
        // and the next order would be refused for a unit that no longer exists.
        if (selected && !unitsById.has(selected)) selected = 0;

        // Which units answer to the player. Guarded by the key, not by "is it
        // empty": an empty list is a real answer (none of ours are left), while
        // a missing one means an older server that calls the whole side ours.
        yours = Array.isArray(data.yours) ? new Set(data.yours) : null;

        orders = data.orders || [];

        redrawBoard();

        shots = data.shots || [];
        running = data.status === 'running';

        if (!running) {
            shots.length = 0;
            shotsGfx.clear();
        }

        // A clock jump that large is a new battle, not drift, so it is taken as
        // is. newBattle is already known above and told the pick to let go.
        battleT += newBattle ? drift : drift * 0.25;

        statusText.text = {
            left_won: 'победа синих',
            right_won: 'победа красных',
            draw: 'ничья',
        }[data.status] || '';

        updateOrderHint();
    }

    function applyLegacyState(data) {
        if (typeof data.seq === 'number') {
            if (data.seq <= lastSeq) return;
            lastSeq = data.seq;
        }

        for (let j = 0; j < 2; j++) {
            for (let i = 0; i < 5; i++) {
                leftT[j][i] = data.leftGrid[j][i] ? { hp: 1, maxHp: 1 } : null;
                rightT[j][i] = data.rightGrid[j][i] ? { hp: 1, maxHp: 1 } : null;
            }
        }

        shots = [];
        orders = [];
        running = false;
        selected = 0;
        yours = null;
        unitsById.clear();
        shotsGfx.clear();
        ordersGfx.clear();
        statusText.text = '';
        redrawBoard();
        updateOrderHint();
    }

    // Which tile a point is in, if any. The tiles were positioned by layout(),
    // so this only has to compare against their current squares.
    function cellAt(x, y) {
        for (let side = 0; side < 2; side++) {
            for (let col = 0; col < 2; col++) {
                for (let row = 0; row < 5; row++) {
                    const s = squareSets[side][col][row];
                    if (x >= s.x && x < s.x + sqX && y >= s.y && y < s.y + sqX) {
                        return { side, col, row };
                    }
                }
            }
        }
        return null;
    }

    function overCircle(x, y) {
        const dx = x - 0.1 * app.screen.width;
        const dy = y - 0.9 * app.screen.height;
        const r = 0.05 * app.screen.height;
        return dx * dx + dy * dy <= r * r;
    }

    // Everything the page responds to starts here: the lobby when it is shown,
    // the board when a room is open.
    function onTap(e) {
        const x = e.global.x;
        const y = e.global.y;

        if (screen === 'lobby') {
            if (createHit(x, y)) {
                setLobbyMsg('создаём…');
                net.send({ action: 'create_room' });
                return;
            }

            const card = cardHit(x, y);
            if (card >= 0) {
                net.send({ action: 'join_room', roomId: cardRects[card].id });
                return;
            }
            return;
        }

        // In a room: the back button first, then the board's own controls — but
        // only the owner commands; a spectator just watches.
        if (leaveHit(x, y)) {
            net.send({ action: 'leave_room' });
            showLobby();
            return;
        }

        if (!amOwner) {
            flash('комната игрока ' + (roomOwnerName || '?') + ' — командует только он', false);
            return;
        }

        if (overCircle(x, y)) {
            console.log('Круг нажат!');
            net.send({ action: 'reset' });
            return;
        }

        const cell = cellAt(x, y);
        if (cell) {
            cellClicked(cell.side, cell.col, cell.row);
            return;
        }

        // Empty space: drop the pick.
        if (selected) {
            selected = 0;
            redrawBoard();
            updateOrderHint();
        }
    }

    // One tap on a cell: a unit of ours becomes the selected one, an enemy cell
    // names its target. The rules are not repeated here - the server checks the
    // order and answers with `order_result`, and the snapshot says which orders
    // are really in force.
    //
    // Not every unit of ours is ours to command, so the tap says so instead of
    // selecting something that could only produce a refusal.
    function cellClicked(side, col, row) {
        const unit = grids[side][col][row];

        if (!running) {
            flash('бой окончен — круг слева начинает новый', false);
            return;
        }

        if (!unit) {
            if (selected) { selected = 0; redrawBoard(); updateOrderHint(); }
            return;
        }

        if (side === 0) {
            if (!canCommand(unit)) {
                flash('этот юнит не твой — командуй светлыми', false);
                return;
            }

            selected = selected === unit.id ? 0 : unit.id;
            redrawBoard();
            updateOrderHint();
            return;
        }

        if (!selected) {
            flash('сначала выберите своего юнита', false);
            return;
        }

        // Tapping the target a unit already has takes the order back; anything
        // else gives a new one. Both travel as the same message, where targetId
        // 0 means "no order".
        const current = orders.find((o) => o.unit === selected);
        const targetId = current && current.target === unit.id ? 0 : unit.id;
        net.send({ action: 'order', unitId: selected, targetId });
    }

    // What the server made of the last order. The wire carries short codes, so
    // the wording lives here, next to the rest of the Russian text. `not-yours`
    // is the other side; `not-commanded` is an ally of ours that fights alone.
    const REASON_TEXT = {
        ok: 'приказ принят',
        cleared: 'приказ снят',
        none: 'приказа уже не было',
        refused: 'цель недоступна',
        'no-unit': 'этот юнит уже мёртв',
        'not-yours': 'это чужой юнит',
        'not-commanded': 'этот юнит не твой — командуй светлыми',
        over: 'бой уже окончен',
        'bad-request': 'сервер не понял приказ',
    };

    function applyOrderResult(data) {
        const text = REASON_TEXT[data.reason]
            || (data.ok ? 'приказ принят' : 'приказ отклонён');
        flash(text, data.ok);
    }

    function flash(text, ok) {
        flashText = text;
        flashUntil = performance.now() + 2200;
        orderHint.style.fill = ok ? 0x9be564 : 0xffb36b;
        setHint(text);
        // A timer, not the render ticker: the reply has to disappear even while
        // the renderer is idle (a background tab stops requestAnimationFrame but
        // keeps the socket open, so the hint must not hang on a frame).
        clearTimeout(flashTimer);
        flashTimer = setTimeout(updateOrderHint, 2200);
    }

    function cellCenter(side, col, row) {
        const square = squareSets[side][col][row];
        return { x: square.x + sqX / 2, y: square.y + sqX / 2 };
    }

    function drawShots() {
        shotsGfx.clear();
        if (!running || shots.length === 0) return;

        for (const shot of shots) {
            if (battleT < shot.fireAt) continue;

            const from = cellCenter(shot.side, shot.from[0], shot.from[1]);
            const to = cellCenter(1 - shot.side, shot.to[0], shot.to[1]);

            const color = TRAIL_COLOR[shot.side];
            shotsGfx.moveTo(from.x, from.y).lineTo(to.x, to.y)
                .stroke({ width: Math.max(2, sqX * 0.03), color, alpha: 0.3 });

            const span = Math.max(1, shot.hitAt - shot.fireAt);
            const progress = Math.max(0, Math.min(1, (battleT - shot.fireAt) / span));

            shotsGfx.circle(
                from.x + (to.x - from.x) * progress,
                from.y + (to.y - from.y) * progress,
                Math.max(3, sqX * 0.07),
            ).fill({ color, alpha: 0.95 });
        }
    }

    // A dotted line from a unit under orders to its target, plus a ring on the
    // target. A shot is a solid line with a travelling dot, so the two cannot be
    // mistaken for each other.
    function drawOrders() {
        ordersGfx.clear();
        if (!running) return;

        for (const order of orders) {
            const from = unitsById.get(order.unit);
            const to = unitsById.get(order.target);
            if (!from || !to) continue;

            const a = cellCenter(from.side, from.col, from.row);
            const b = cellCenter(to.side, to.col, to.row);
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy);
            if (len <= 1) continue;

            // The dots start and end inside the two tiles, so the line reads as
            // running from unit to unit rather than across the glyphs.
            const color = TRAIL_COLOR[from.side];
            const pad = sqX * 0.6;
            const t0 = pad / len;
            const t1 = 1 - pad / len;

            if (t1 > t0) {
                const dots = 7;
                for (let i = 0; i < dots; i++) {
                    const t = t0 + (t1 - t0) * (i / (dots - 1));
                    ordersGfx.circle(a.x + dx * t, a.y + dy * t, Math.max(1.5, sqX * 0.03))
                        .fill({ color, alpha: 0.55 });
                }
            }

            ordersGfx.circle(b.x, b.y, sqX * 0.3)
                .stroke({ width: Math.max(2, sqX * 0.035), color, alpha: 0.55 });
        }
    }

    function setHint(text) {
        if (orderHint.text !== text) orderHint.text = text;
    }

    function updateOrderHint() {
        // The reply to the last tap is still up: leave it alone until its timer
        // puts the standing hint back.
        if (performance.now() < flashUntil) return;

        if (orderHint.style.fill !== 0xffffff) orderHint.style.fill = 0xffffff;

        // A spectator sees the same board but has nothing to command.
        if (!amOwner) {
            setHint('зритель — бой ведёт ' + (roomOwnerName || 'хозяин комнаты'));
            return;
        }

        if (!running) {
            setHint('бой окончен — круг слева начинает новый');
            return;
        }

        if (selected) {
            const ordered = orders.some((o) => o.unit === selected);
            setHint(ordered
                ? 'приказ отдан · тап по тому же врагу снимает его, по другому — меняет'
                : 'выберите цель: тап по врагу отдаёт приказ');
            return;
        }

        setHint('светлые юниты — твои: тап по своему, потом по врагу');
    }

    app.ticker.add((ticker) => {
        if (running) battleT += ticker.deltaMS;
        drawOrders();
        drawShots();
    });

    // The renderer fires 'resize' after app.screen already holds the new size,
    // which the window event does not guarantee (listener order). resizeTo:window
    // keeps the renderer itself in step with the window.
    app.renderer.on('resize', layout);
    layout();
})();
