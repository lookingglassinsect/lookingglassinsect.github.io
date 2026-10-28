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

    const leftT = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0]
    ];

    const rightT = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0]
    ];

    const leftSquares = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0]
    ];
    const rightSquares = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0]
    ];

    // Everything below is created once and positioned by layout(). Nothing keeps
    // a position or a size that was computed at startup, because that is what
    // used to desync the panels from the squares after a resize.
    const rect = new PIXI.Graphics();
    const panel1 = new PIXI.Graphics();
    const panel2 = new PIXI.Graphics();
    const circle = new PIXI.Graphics();

    // Side of one square, in screen pixels. drawSquare() needs it, and layout()
    // recomputes it on every resize.
    let sqX = 0;

    function drawSquare(g, isOn) {
        g.clear();
        g.rect(0, 0, sqX, sqX).fill(isOn ? 0xffffff : 0x000000);
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
                drawSquare(left, leftT[j][i]);

                const right = rightSquares[j][i];
                right.x = w - sqX - (0.08 * w + sqX * j + sqIndentX * j);
                right.y = 0.05 * h + sqX * i + sqIndentY * i;
                drawSquare(right, rightT[j][i]);
            }
        }

        circle.clear()
            .circle(0, 0, 0.05 * h)
            .fill(0x2ecc71);
        circle.x = 0.1 * w;
        circle.y = 0.9 * h;
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

    const net = createNetwork(
        'wss://clickerbase.ru:9000',
        handleServerMessage,
        // A restarted server counts from 1 again. Without this reset the board
        // would ignore everything it sent after the restart.
        () => { lastSeq = 0; },
    );

    function handleServerMessage(data) {
        console.log('Сервер прислал:', data);
        if (data.action === 'state') {
            if (typeof data.seq === 'number') {
                if (data.seq <= lastSeq) {
                    console.log('Ignoring stale state, seq', data.seq, '<=', lastSeq);
                    return;
                }
                lastSeq = data.seq;
            }

            for (let j = 0; j < 2; j++) {
                for (let i = 0; i < 5; i++) {
                    leftT[j][i] = data.leftGrid[j][i];
                    rightT[j][i] = data.rightGrid[j][i];

                    drawSquare(leftSquares[j][i], leftT[j][i]);
                    drawSquare(rightSquares[j][i], rightT[j][i]);
                }
            }
        }
    }

    // The renderer fires 'resize' after app.screen already holds the new size,
    // which the window event does not guarantee (listener order). resizeTo:window
    // keeps the renderer itself in step with the window.
    app.renderer.on('resize', layout);
    layout();
})();
