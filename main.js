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

    const rect = new PIXI.Graphics()
        .rect(0.02*app.screen.width, 0.85*app.screen.height, 0.96*app.screen.width, 0.1*app.screen.height)
        .fill(0xe94560);
  //  rect.x =
  const panel1 = new PIXI.Graphics()
        .rect(0.05*app.screen.width, 0.02*app.screen.height, 0.4*app.screen.width, 0.8*app.screen.height)
        .fill(0xe94560);

  const panel2 = new PIXI.Graphics()
        .rect(0.55*app.screen.width, 0.02*app.screen.height, 0.4*app.screen.width, 0.8*app.screen.height)
        .fill(0xe94560);


    const centerRect = () => {

    };

    function drawSquare(g, isOn) {
    g.clear();
    g.rect(0, 0, sqX, sqX).fill(isOn ? 0xffffff : 0x000000);
}

    centerRect();
    app.stage.addChild(rect);
    app.stage.addChild(panel1);
    app.stage.addChild(panel2);

    const sizeX = 0.4*app.screen.width;
    const sizeY = 0.8*app.screen.height;

    const borderIndentX = 0.03 * app.screen.width ;
    const borderIndentY = 0.03 * app.screen.height;
    
    const sqIndentX = 0.02 * app.screen.width ;
    const sqIndentY = 0.02 * app.screen.height;

    const sqX = (sizeY - borderIndentY*2 - sqIndentY*4)/5;


for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 5; i++) {
        const square = new PIXI.Graphics();
        square.x = 0.08*app.screen.width + sqX*j + sqIndentX*j;
        square.y = 0.05*app.screen.height + sqX*i + sqIndentY*i;
        square.rect(0, 0, sqX, sqX).fill(0x000000);
        leftSquares[j][i] = square;
        app.stage.addChild(square);
    }
}

for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 5; i++) {
        const square = new PIXI.Graphics();
        square.x = app.screen.width - sqX - (0.08*app.screen.width + sqX*j + sqIndentX*j);
        square.y = 0.05*app.screen.height + sqX*i + sqIndentY*i;
        square.rect(0, 0, sqX, sqX).fill(0x000000);
        rightSquares[j][i] = square;
        app.stage.addChild(square);
    }
}

const circle = new PIXI.Graphics()
    .circle(0.1*app.screen.width, 0.9*app.screen.height, app.screen.height*0.05)   
    .fill(0xf09000);

    circle.eventMode = 'static';
    circle.on('pointerdown', () => {
    console.log('Круг нажат!');
    net.send({ action: 'reset'});
});

app.stage.addChild(circle);

        const net = createNetwork('wss://clickerbase.ru:9000', handleServerMessage);

    function handleServerMessage(data) {

    console.log('Сервер прислал:', data);
    if (data.action=="state") {
        for (let j=0; j<2; j++)
            for (let i=0; i<5; i++) {
            leftT[j][i] = data.leftGrid[j][i];
            rightT[j][i] = data.rightGrid[j][i];
            
            drawSquare(leftSquares[j][i],  leftT[j][i]);
            drawSquare(rightSquares[j][i], rightT[j][i]);

            }


        console.log(data.leftGrid[0][0]);

    }
}


    net.send({ action: 'toggle', index: 0 });


    window.addEventListener('resize', centerRect);
})();


