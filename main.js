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

    // Everything below is created once and positioned by layout(). Nothing keeps
    // a position or a size that was computed at startup, because that is what
    // used to desync the panels from the squares after a resize.
    const rect = new PIXI.Graphics();
    const panel1 = new PIXI.Graphics();
    const panel2 = new PIXI.Graphics();
    const circle = new PIXI.Graphics();
    const shotsGfx = new PIXI.Graphics();

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

    // Side of one square, in screen pixels. drawCell() needs it, and layout()
    // recomputes it on every resize.
    let sqX = 0;

    function drawCell(g, unit, side) {
        g.clear();

        if (!unit) {
            g.roundRect(0, 0, sqX, sqX, sqX * 0.08).fill(EMPTY_COLOR);
            return;
        }

        g.roundRect(0, 0, sqX, sqX, sqX * 0.08).fill(SIDE_COLOR[side]);

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

        statusText.style.fontSize = Math.round(0.055 * h);
        statusText.x = 0.62 * w;
        statusText.y = 0.9 * h;
    }

    app.stage.addChild(rect);
    app.stage.addChild(panel1);
    app.stage.addChild(panel2);

    for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 5; i++) {
            const square = new PIXI.Graphics();
            leftSquares[j][i] = square;
            app.stage.addChild(square);
        }
    }

    for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 5; i++) {
            const square = new PIXI.Graphics();
            rightSquares[j][i] = square;
            app.stage.addChild(square);
        }
    }

    // Above the squares: a shot is drawn between two of them.
    app.stage.addChild(shotsGfx);
    app.stage.addChild(statusText);
    app.stage.addChild(hintText);

    circle.eventMode = 'static';
    circle.on('pointerdown', () => {
        console.log('Круг нажат!');
        net.send({ action: 'reset' });
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

        for (const unit of data.units) {
            const grid = unit.side === 0 ? leftT : rightT;
            if (unit.col < 0 || unit.col > 1 || unit.row < 0 || unit.row > 4) continue;
            grid[unit.col][unit.row] = unit;
        }

        redrawBoard();

        shots = data.shots || [];
        running = data.status === 'running';

        if (!running) {
            shots.length = 0;
            shotsGfx.clear();
        }

        // A new battle resets the server's clock to zero, which is a jump far
        // bigger than the drift this smooths; anything that large is taken as is.
        const drift = data.t - battleT;
        battleT += Math.abs(drift) > 250 ? drift : drift * 0.25;

        statusText.text = {
            left_won: 'победа синих',
            right_won: 'победа красных',
            draw: 'ничья',
        }[data.status] || '';
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
        running = false;
        shotsGfx.clear();
        statusText.text = '';
        redrawBoard();
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

    app.ticker.add((ticker) => {
        if (running) battleT += ticker.deltaMS;
        drawShots();
    });

    // The renderer fires 'resize' after app.screen already holds the new size,
    // which the window event does not guarantee (listener order). resizeTo:window
    // keeps the renderer itself in step with the window.
    app.renderer.on('resize', layout);
    layout();
})();
