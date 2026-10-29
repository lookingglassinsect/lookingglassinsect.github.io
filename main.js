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
    }

    app.stage.addChild(rect);
    app.stage.addChild(panel1);
    app.stage.addChild(panel2);

    // A cell is also the board's only control, but the handlers live on the tap
    // layer above, not on the tiles: see tapLayer.
    for (const side of [0, 1]) {
        for (let j = 0; j < 2; j++) {
            for (let i = 0; i < 5; i++) {
                const square = new PIXI.Graphics();
                squareSets[side][j][i] = square;
                app.stage.addChild(square);
            }
        }
    }

    // Above the squares: a shot is drawn between two of them, and under it the
    // dotted line that shows which unit is under orders and against whom.
    app.stage.addChild(ordersGfx);
    app.stage.addChild(shotsGfx);
    app.stage.addChild(statusText);
    app.stage.addChild(hintText);
    app.stage.addChild(orderHint);
    app.stage.addChild(tapLayer);

    tapLayer.on('pointerdown', onTap);
    // A hint that something is clickable, from the same arithmetic as the tap.
    tapLayer.on('pointermove', (e) => {
        const over = overCircle(e.global.x, e.global.y) || cellAt(e.global.x, e.global.y);
        app.canvas.style.cursor = over ? 'pointer' : 'default';
    });

    app.stage.addChild(circle);

    // Highest sequence number shown so far. Broadcasts are not ordered — two
    // threads can deliver snapshots in the opposite order — so anything not
    // newer than this is a state the board has already moved past.
    let lastSeq = 0;

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

    // The ids the server says are the player's to command. Our side is not all
    // ours: the rest of the line is an ally that fights by itself. Null means
    // the server did not say - an older build - and then every unit of ours is
    // treated as commandable, which is how it used to be.
    let yours = null;

    function canCommand(unit) {
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
        // A restarted server counts from 1 again. Without this reset the board
        // would ignore everything it sent after the restart.
        () => { lastSeq = 0; },
    );

    function handleServerMessage(data) {
        console.log('Сервер прислал:', data);

        if (data.action === 'battle') {
            applyBattle(data);
        }
        else if (data.action === 'order_result') {
            applyOrderResult(data);
        }
        else if (data.action === 'state') {
            // The older server (the binary kept as server.prev) still sends the
            // plain 0/1 board. Kept so a rollback does not blank the page; it
            // can go once nothing can be rolled back to.
            applyLegacyState(data);
        }
    }

    function applyBattle(data) {
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

    // Everything the board responds to starts here.
    function onTap(e) {
        const x = e.global.x;
        const y = e.global.y;

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
