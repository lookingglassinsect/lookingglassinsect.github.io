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

    // Six classes, one sprite each. A class is a skin for now: it picks which
    // model stands on the tile and changes nothing about how the unit fights.
    // Loaded once at startup so drawCell can swap a sprite in for the glyph; a
    // sprite that fails to load leaves that class on the glyph fallback.
    const CLASS_NAMES = ['knight', 'berserker', 'assassin', 'healer', 'mage', 'archer'];
    const classTextures = {};
    for (const name of CLASS_NAMES) {
        try {
            classTextures[name] = await PIXI.Assets.load(`assets/${name}.png`);
        } catch (err) {
            console.warn(`asset ${name} not loaded:`, err);
        }
    }

    // The one ability every player-controlled unit has. Loaded once here; if it
    // is missing the button still draws its circle and a white placeholder.
    let abilityTexture = null;
    try {
        abilityTexture = await PIXI.Assets.load('assets/abilities/abil1.png');
    } catch (err) {
        console.warn('ability asset not loaded:', err);
    }

    // Empty equipment-slot silhouettes and the three item icons. Loaded once,
    // like the class sprites; a missing asset leaves that slot on its plain
    // background instead of failing the whole page.
    const emptySlotTextures = {};
    for (const name of ['helmet', 'amulet', 'body', 'weapon', 'pants', 'gloves', 'boots', 'ring']) {
        try {
            emptySlotTextures[name] = await PIXI.Assets.load(`assets/invrentory/empty_${name}.png`);
        } catch (err) {
            console.warn(`empty slot asset ${name} not loaded:`, err);
        }
    }
    const itemTextures = {};
    for (const name of ['newbie_helmet', 'newbie_sword', 'newbie_boots']) {
        try {
            itemTextures[name] = await PIXI.Assets.load(`assets/items/${name}.png`);
        } catch (err) {
            console.warn(`item asset ${name} not loaded:`, err);
        }
    }

    // A cell holds a unit or nothing. The server sends a flat list of units;
    // these two grids are that list laid out by cell, [side][col][row], where
    // col 1 is the front line next to the middle of the board. Side 0 is the
    // left, side 1 the right; which of them is ours depends on the room.
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

    // Side 0 is blue and the left, side 1 red and the right, and a shot keeps
    // the colour of the side it came from. In PvE the player commands the left;
    // in PvP the guest commands the right, so "our side" is not always the left.
    const SIDE_COLOR = [0x3d7dd8, 0xd8503d];
    const TRAIL_COLOR = [0x4aa3ff, 0xff5a4a];
    const EMPTY_COLOR = 0x1b2744;
    const SELECT_COLOR = 0xffe680;

    // The one unit the player commands is their own side in a paler shade: the
    // allies' four keep the normal one. The whole mark is the colour of the
    // tile, because a bar or a badge would fight for room with the role glyph
    // and the health bar that already sit there.
    const MINE_COLOR = [0x62b0f0, 0xe58a76];

    // Russian names for the class picker title. The assets and the wire keep
    // the English ids; this is display-only.
    const CLASS_RU = {
        knight: 'Рыцарь',
        berserker: 'Берсерк',
        assassin: 'Ассасин',
        healer: 'Целитель',
        mage: 'Маг',
        archer: 'Лучник',
    };

    // Display metadata for the item types. The server is authoritative for the
    // effects (hp/damage arrive on the item itself); this only names the item,
    // says which slot it fits and picks its icon.
    const ITEM_DEFS = {
        newbie_helmet: { slot: 'helmet', name: 'Шлем новичка', icon: 'newbie_helmet' },
        newbie_sword:  { slot: 'weapon',  name: 'Меч новичка',  icon: 'newbie_sword' },
        newbie_boots:  { slot: 'boots',   name: 'Сапоги новичка', icon: 'newbie_boots' },
    };

    // Display names for the equipment slots, used in the item description.
    const SLOT_RU = {
        helmet: 'шлем',
        amulet: 'амулет',
        body: 'броня',
        weapon: 'оружие',
        pants: 'штаны',
        gloves: 'перчатки',
        boots: 'сапоги',
        ring: 'кольцо',
    };

    // Everything below is created once and positioned by layout(). Nothing keeps
    // a position or a size that was computed at startup, because that is what
    // used to desync the panels from the squares after a resize.
    const rect = new PIXI.Graphics();
    const panel1 = new PIXI.Graphics();
    const panel2 = new PIXI.Graphics();
    const circle = new PIXI.Graphics();
    const ordersGfx = new PIXI.Graphics();
    const shotsGfx = new PIXI.Graphics();

    // The ability button on the bottom panel: a circle for the base, the ability
    // icon on top, a Graphics for the cooldown sweep, and a Text for the seconds
    // left. fxGfx draws the short cast animation (a burst on the target, a pulse
    // on the button) so it can be cleared and redrawn each frame like the shots.
    const abilityBtn = new PIXI.Graphics();
    const abilityIcon = new PIXI.Sprite(abilityTexture || PIXI.Texture.WHITE);
    abilityIcon.anchor.set(0.5);
    const abilityCdGfx = new PIXI.Graphics();
    const abilityCdText = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    abilityCdText.anchor.set(0.5);
    const fxGfx = new PIXI.Graphics();

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

    // The big 3-2-1 in the middle of the board during a PvP countdown. Hidden
    // the rest of the time; layout() keeps its size and centre current.
    const countdownText = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    countdownText.anchor.set(0.5);
    countdownText.visible = false;

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

    // Two ways to make a room: a PvE room (one player against bots) or a PvP
    // room (two players, one per side, and everyone else watching).
    const createPveBtn = new PIXI.Graphics();
    const createPveBtnText = new PIXI.Text({
        text: 'Создать PvE',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    createPveBtnText.anchor.set(0.5, 0.5);
    const createPvpBtn = new PIXI.Graphics();
    const createPvpBtnText = new PIXI.Text({
        text: 'Создать PvP',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    createPvpBtnText.anchor.set(0.5, 0.5);

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

    // The character overlay: one scene that shows either the class picker (a
    // fresh account has no class yet) or the character page (opened from the
    // lobby's top-right button). Both are Pixi, drawn above the lobby, and
    // routed through the same tapLayer as everything else.
    const charScene = new PIXI.Container();
    const charBackdrop = new PIXI.Graphics();
    const charPanel = new PIXI.Graphics();
    const charTitle = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    charTitle.anchor.set(0.5, 0.5);
    const charSprite = new PIXI.Sprite();
    charSprite.anchor.set(0.5);
    const charStats = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff },
    });
    const arrowLeft = new PIXI.Graphics();
    const arrowRight = new PIXI.Graphics();
    const charActionBtn = new PIXI.Graphics();
    const charActionBtnText = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    charActionBtnText.anchor.set(0.5, 0.5);
    const charCloseBtn = new PIXI.Graphics();
    const charCloseBtnText = new PIXI.Text({
        text: '✕',
        style: { fontFamily: 'monospace', fill: 0xffffff },
    });
    charCloseBtnText.anchor.set(0.5, 0.5);

    // The lobby's button into the character page, top-right.
    const charBtn = new PIXI.Graphics();
    const charBtnText = new PIXI.Text({
        text: 'персонаж',
        style: { fontFamily: 'monospace', fill: 0xffffff },
    });
    charBtnText.anchor.set(0.5, 0.5);

    // The inventory overlay: one Pixi scene drawn above the lobby, like the
    // character page. Left = the character, center = the equipment slots,
    // right = the backpack, the selected item's description, a placeholder
    // panel (future abilities) and the delete button.
    const invScene = new PIXI.Container();
    const invBackdrop = new PIXI.Graphics();
    const invPanel = new PIXI.Graphics();
    const invTitle = new PIXI.Text({
        text: 'Инвентарь',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    invTitle.anchor.set(0.5, 0);
    const invCharSprite = new PIXI.Sprite();
    invCharSprite.anchor.set(0.5);
    const invCharName = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    const invCharStats = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff },
    });
    const invDescText = new PIXI.Text({
        text: '',
        style: { fontFamily: 'monospace', fill: 0xffffff },
    });
    const invEmptyPanel = new PIXI.Graphics();
    const invDeleteBtn = new PIXI.Graphics();
    const invDeleteBtnText = new PIXI.Text({
        text: 'удалить',
        style: { fontFamily: 'monospace', fill: 0xffffff, fontWeight: 'bold' },
    });
    invDeleteBtnText.anchor.set(0.5, 0.5);
    const invCloseBtn = new PIXI.Graphics();
    const invCloseBtnText = new PIXI.Text({
        text: '✕',
        style: { fontFamily: 'monospace', fill: 0xffffff },
    });
    invCloseBtnText.anchor.set(0.5, 0.5);

    // One container per slot holds a background, the empty-slot silhouette and
    // the item icon on top. Created once; layout sets geometry, render sets
    // textures and the selection highlight.
    const invSlots = new PIXI.Container();
    function makeSlot(parent) {
        const container = new PIXI.Container();
        const bg = new PIXI.Graphics();
        const emptySprite = new PIXI.Sprite(PIXI.Texture.WHITE);
        emptySprite.anchor.set(0.5);
        const itemSprite = new PIXI.Sprite(PIXI.Texture.WHITE);
        itemSprite.anchor.set(0.5);
        container.addChild(bg, emptySprite, itemSprite);
        parent.addChild(container);
        return { container, bg, emptySprite, itemSprite, rect: null };
    }
    const equipSlots = [
        { slot: 'helmet', emptyName: 'helmet' },
        { slot: 'amulet', emptyName: 'amulet' },
        { slot: 'body',   emptyName: 'body' },
        { slot: 'weapon', emptyName: 'weapon' },
        { slot: 'pants',  emptyName: 'pants' },
        { slot: 'gloves', emptyName: 'gloves' },
        { slot: 'boots',  emptyName: 'boots' },
        { slot: 'ring0',  emptyName: 'ring' },
        { slot: 'ring1',  emptyName: 'ring' },
        { slot: 'ring2',  emptyName: 'ring' },
        { slot: 'ring3',  emptyName: 'ring' },
        { slot: 'ring4',  emptyName: 'ring' },
    ].map((d) => Object.assign({ slot: d.slot, emptyName: d.emptyName }, makeSlot(invSlots)));
    const backpackSlots = Array.from({ length: 15 }, (_, index) =>
        Object.assign({ index }, makeSlot(invSlots)));

    // The lobby's button into the inventory, under the character button.
    const invBtn = new PIXI.Graphics();
    const invBtnText = new PIXI.Text({
        text: 'инвентарь',
        style: { fontFamily: 'monospace', fill: 0xffffff },
    });
    invBtnText.anchor.set(0.5, 0.5);

    // Hit-test rectangles, filled by layoutLobby()/renderLobby() and read by the
    // tap layer. They are plain data for the same reason the board routes taps
    // through arithmetic rather than per-shape handlers.
    let createPveRect = null;
    let createPvpRect = null;
    let leaveRect = null;
    let cardRects = [];
    let cardObjects = [];
    let canCreate = true;
    let hoverCreate = null;   // null | 'pve' | 'pvp'
    let hoverCard = -1;

    // Character overlay hit-test rectangles, filled by layoutCharScene()/
    // layoutLobby() and read by the tap layer.
    let charPanelRect = null;
    let arrowLeftRect = null;
    let arrowRightRect = null;
    let actionBtnRect = null;
    let closeBtnRect = null;
    let charBtnRect = null;
    let hoverCharBtn = false;
    let charSpriteSize = 0;
    let deleteBtnRect = null;
    let invCloseRect = null;
    let invBtnRect = null;
    let hoverInvBtn = false;

    // Side of one square, in screen pixels. drawCell() needs it, and layout()
    // recomputes it on every resize.
    let sqX = 0;

    // The ability's state on this client. The cooldown is tracked as a wall-clock
    // deadline so it counts down smoothly between snapshots and stays correct
    // after a background tab pauses the renderer; the server's value is folded
    // back in on every snapshot.
    let abilityR = 0;              // button radius, set by layout()
    let abilityTargeting = false;  // armed: the next enemy tap casts
    let abilityCdUntil = 0;        // performance.now() when the ability is ready
    let abilityCdTotal = 10000;    // from the snapshot's ability.cooldownMs
    let abilityBurst = null;       // { side, col, row, until } ring on the hit target
    let abilityPulseUntil = 0;     // button pulse until this timestamp
    const FX_MS = 350;             // how long the cast animation runs

    function drawCell(g, unit, side) {
        // A cell is one Graphics for the tile plus two children drawn on top:
        // the class sprite (which fills the whole tile) and an overlay for the
        // selection ring and the health bar. Both are created once, in this
        // order, so the overlay always sits above the sprite.
        if (!g.modelSprite) {
            g.modelSprite = new PIXI.Sprite();
            g.modelSprite.anchor.set(0.5);
            g.addChild(g.modelSprite);
        }
        if (!g.overlay) {
            g.overlay = new PIXI.Graphics();
            g.addChild(g.overlay);
        }

        g.clear();
        g.overlay.clear();

        if (!unit) {
            g.modelSprite.visible = false;
            g.roundRect(0, 0, sqX, sqX, sqX * 0.08).fill(EMPTY_COLOR);
            return;
        }

        // A tile whose unit answers to the player is painted in a paler shade of
        // their side's colour. Most of our line is an ally fighting on its own,
        // and without the tint there is no way to tell which taps do anything
        // until one is refused.
        const mine = side === mySide && canCommand(unit);
        g.roundRect(0, 0, sqX, sqX, sqX * 0.08).fill(mine ? MINE_COLOR[side] : SIDE_COLOR[side]);

        // A class is a skin: when its sprite is loaded, it fills the whole tile
        // in place of the role glyph. The glyph stays as the fallback for an
        // older server that sends no class, or a sprite that failed to load. A
        // square is a melee unit, a diamond a ranged one; the column already
        // tells the player which line the unit stands in.
        if (unit.class && classTextures[unit.class]) {
            g.modelSprite.texture = classTextures[unit.class];
            g.modelSprite.width = sqX;
            g.modelSprite.height = sqX;
            g.modelSprite.position.set(sqX * 0.5, sqX * 0.5);
            g.modelSprite.visible = true;
        }
        else {
            g.modelSprite.visible = false;

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
        }

        // The unit the player has picked to command, drawn on the overlay so the
        // ring stays visible on top of a full-tile sprite.
        if (side === mySide && unit.id === selected) {
            const inset = Math.max(1.5, sqX * 0.05);
            g.overlay.roundRect(inset, inset, sqX - inset * 2, sqX - inset * 2, sqX * 0.05)
                .stroke({ width: Math.max(2, sqX * 0.045), color: SELECT_COLOR, alpha: 0.95 });
        }

        // Health as a bar along the bottom, also on the overlay so it reads on
        // top of the sprite. It is the only number on the board for now, and a
        // bar reads faster than a number would.
        const pad = sqX * 0.12;
        const barH = Math.max(3, sqX * 0.12);
        const barW = sqX - pad * 2;
        const barY = sqX - pad - barH;

        const frac = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
        g.overlay.rect(pad, barY, barW, barH).fill(0x0d1526);

        if (frac > 0) {
            const color = frac > 0.5 ? 0x51cf66 : frac > 0.25 ? 0xffd43b : 0xff6b6b;
            g.overlay.rect(pad, barY, barW * frac, barH).fill(color);
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

        // The ability button mirrors the reset circle on the right edge. Drawn
        // at the local origin and positioned through .x/.y, like the circle.
        abilityR = 0.05 * h;
        abilityBtn.x = 0.9 * w;
        abilityBtn.y = 0.9 * h;
        abilityCdGfx.x = abilityBtn.x;
        abilityCdGfx.y = abilityBtn.y;
        abilityIcon.x = abilityBtn.x;
        abilityIcon.y = abilityBtn.y;
        abilityIcon.width = abilityR * 1.5;
        abilityIcon.height = abilityR * 1.5;
        abilityCdText.x = abilityBtn.x;
        abilityCdText.y = abilityBtn.y;
        abilityCdText.style.fontSize = Math.round(abilityR * 0.7);
        paintAbility();

        hintText.style.fontSize = Math.round(0.045 * h);
        hintText.x = 0.16 * w;
        hintText.y = 0.9 * h;

        orderHint.style.fontSize = Math.max(9, Math.round(0.028 * h));
        orderHint.x = 0.5 * w;
        orderHint.y = 0.838 * h;

        statusText.style.fontSize = Math.round(0.055 * h);
        statusText.x = 0.62 * w;
        statusText.y = 0.9 * h;

        countdownText.style.fontSize = Math.round(0.2 * h);
        countdownText.x = 0.5 * w;
        countdownText.y = 0.5 * h;

        layoutLobby();
        layoutCharScene();
        layoutInventory();

        // A resize also re-lays the cards; they are positioned from the screen,
        // not from a stored size, so they have to be rebuilt at the new size.
        if (screen === 'lobby' && lastLobby) {
            renderLobby(lastLobby.rooms, lastLobby.max);
        }

        // The overlay is laid from the screen too; re-render whichever mode is
        // showing so a resize does not drop its text or textures.
        if (overlay === 'select') renderCharSelect();
        else if (overlay === 'profile') renderCharProfile();
        else if (overlay === 'inventory') renderInventory();
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

        const bw = Math.min(0.24 * w, 190);
        const bh = Math.round(0.09 * h);
        const bgap = Math.round(0.02 * w);
        const total = bw * 2 + bgap;
        const bx = (w - total) / 2;
        createPveRect = { x: bx, y: 0.24 * h, w: bw, h: bh };
        createPvpRect = { x: bx + bw + bgap, y: 0.24 * h, w: bw, h: bh };
        createPveBtnText.style.fontSize = Math.round(0.035 * h);
        createPveBtnText.x = createPveRect.x + bw / 2;
        createPveBtnText.y = 0.24 * h + bh / 2;
        createPvpBtnText.style.fontSize = Math.round(0.035 * h);
        createPvpBtnText.x = createPvpRect.x + bw / 2;
        createPvpBtnText.y = 0.24 * h + bh / 2;

        lobbyMsg.style.fontSize = Math.round(0.028 * h);
        lobbyMsg.x = 0.5 * w;
        lobbyMsg.y = 0.24 * h + bh + 0.022 * h;

        const lw = Math.round(0.16 * w);
        const lh = Math.round(0.06 * h);
        leaveRect = { x: 0.02 * w, y: 0.02 * h, w: lw, h: lh };
        leaveBtnText.style.fontSize = Math.round(0.026 * h);
        leaveBtnText.x = 0.02 * w + lw / 2;
        leaveBtnText.y = 0.02 * h + lh / 2;

        const cbw = Math.round(0.15 * w);
        const cbh = Math.round(0.06 * h);
        charBtnRect = { x: w - cbw - 0.02 * w, y: 0.02 * h, w: cbw, h: cbh };
        charBtnText.style.fontSize = Math.round(0.026 * h);
        charBtnText.x = charBtnRect.x + cbw / 2;
        charBtnText.y = charBtnRect.y + cbh / 2;

        const ibw = Math.round(0.15 * w);
        const ibh = Math.round(0.06 * h);
        invBtnRect = { x: w - ibw - 0.02 * w, y: 0.02 * h + cbh + 0.012 * h, w: ibw, h: ibh };
        invBtnText.style.fontSize = Math.round(0.026 * h);
        invBtnText.x = invBtnRect.x + ibw / 2;
        invBtnText.y = invBtnRect.y + ibh / 2;

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
    boardScene.addChild(fxGfx);
    boardScene.addChild(statusText);
    boardScene.addChild(countdownText);
    boardScene.addChild(hintText);
    boardScene.addChild(orderHint);
    boardScene.addChild(circle);
    boardScene.addChild(abilityBtn);
    boardScene.addChild(abilityIcon);
    boardScene.addChild(abilityCdGfx);
    boardScene.addChild(abilityCdText);
    boardScene.addChild(leaveBtn);
    boardScene.addChild(leaveBtnText);

    lobbyScene.addChild(lobbyTitle);
    lobbyScene.addChild(titleUnderline);
    lobbyScene.addChild(createPveBtn);
    lobbyScene.addChild(createPveBtnText);
    lobbyScene.addChild(createPvpBtn);
    lobbyScene.addChild(createPvpBtnText);
    lobbyScene.addChild(lobbyMsg);
    lobbyScene.addChild(lobbyCards);
    lobbyScene.addChild(charBtn);
    lobbyScene.addChild(charBtnText);
    lobbyScene.addChild(invBtn);
    lobbyScene.addChild(invBtnText);

    charScene.addChild(charBackdrop, charPanel, charTitle, charSprite, charStats,
                       arrowLeft, arrowRight, charActionBtn, charActionBtnText,
                       charCloseBtn, charCloseBtnText);

    invScene.addChild(invBackdrop, invPanel, invTitle, invCharSprite, invCharName,
                      invCharStats, invSlots, invDescText, invEmptyPanel,
                      invDeleteBtn, invDeleteBtnText, invCloseBtn, invCloseBtnText);

    app.stage.addChild(boardScene);
    app.stage.addChild(lobbyScene);
    app.stage.addChild(charScene);
    app.stage.addChild(invScene);
    app.stage.addChild(tapLayer);

    // The login form covers both scenes until the player is authenticated.
    boardScene.visible = false;
    lobbyScene.visible = false;
    charScene.visible = false;
    invScene.visible = false;

    tapLayer.on('pointerdown', onTap);
    // A hint that something is clickable, from the same arithmetic as the tap.
    tapLayer.on('pointermove', (e) => {
        const x = e.global.x;
        const y = e.global.y;
        let over = false;

        if (overlay === 'select') {
            over = inRect(x, y, arrowLeftRect) || inRect(x, y, arrowRightRect)
                || inRect(x, y, actionBtnRect);
        } else if (overlay === 'profile') {
            over = inRect(x, y, actionBtnRect) || inRect(x, y, closeBtnRect);
        } else if (overlay === 'inventory') {
            over = invHit(x, y) || inRect(x, y, deleteBtnRect) || inRect(x, y, invCloseRect);
        } else if (screen === 'lobby') {
            const nc = createHit(x, y);
            const ni = cardHit(x, y);
            const ch = charHit(x, y);
            const ih = inRect(x, y, invBtnRect);
            if (nc !== hoverCreate || ni !== hoverCard || ch !== hoverCharBtn || ih !== hoverInvBtn) {
                hoverCreate = nc;
                hoverCard = ni;
                hoverCharBtn = ch;
                hoverInvBtn = ih;
                paintLobby();
            }
            over = nc || ni >= 0 || ch || ih;
        } else {
            over = leaveHit(x, y) || (amOwner && overCircle(x, y))
                || (mySide >= 0 && abilityHit(x, y)) || cellAt(x, y);
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
    let mySide = -1;      // which side is ours: 0 left, 1 right, -1 spectator
    let roomMode = 'pve';
    let roomOwnerName = '';

    // The last lobby list shown, kept so a resize can re-render the cards at the
    // new size without asking the server again.
    let lastLobby = null;

    // The player's chosen class ('' until they pick one), the six classes the
    // server described, and which of them the picker is currently showing.
    let myCls = '';
    let classList = [];
    let overlay = null;      // null | 'select' | 'profile' | 'inventory'
    let charIndex = 0;

    // The player's gear, from the server. `myInventory` is the 15 backpack
    // slots (null = empty), `myEquipment` the worn slots keyed by name, and
    // `invSelectedUid` the item the description and the delete button act on.
    let myInventory = [];
    let myEquipment = {};
    let invSelectedUid = null;

    // Our own copy of the battle clock, in milliseconds since the battle began.
    // It runs every frame, so a shot can be drawn between two snapshots instead
    // of jumping 50 ms at a time; each snapshot nudges it back towards the
    // server's time.
    let battleT = 0;
    let shots = [];
    let running = false;
    let roomStatus = 'running';   // last battle.status the server sent

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
        if (mySide < 0) return false;
        return yours === null || yours.has(unit.id);
    }

    // The one unit the player commands (0 when there is none, e.g. it died). The
    // ability is cast by it, so the button needs this id to address it.
    function myUnitId() {
        if (!yours) return 0;
        for (const id of yours) return id;
        return 0;
    }

    // Milliseconds until the ability can be cast again, from the local deadline.
    function abilityRemaining() {
        return Math.max(0, abilityCdUntil - performance.now());
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
            myCls = data.cls || '';
            if (Array.isArray(data.classes)) classList = data.classes;
            myInventory = Array.isArray(data.inventory) ? data.inventory : [];
            myEquipment = data.equipment && typeof data.equipment === 'object' ? data.equipment : {};
            invSelectedUid = null;
            setLoginMsg('');

            if (screen === 'room' && roomId) {
                // A reconnect while in a room: back in after the token is accepted.
                net.send({ action: 'join_room', roomId });
            } else {
                showLobby();
                // A fresh account has not picked a class yet; the picker opens
                // on top of the lobby and stays until one is chosen.
                if (!myCls) openCharSelect();
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
        switch (status) {
            case 'waiting':   return 'ждёт противника';
            case 'ready':     return 'готов к бою';
            case 'countdown': return 'обратный отсчёт';
            case 'running':   return 'бой идёт';
            default:          return 'бой окончен';
        }
    }

    function inRect(x, y, r) {
        return r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    }

    function createHit(x, y) {
        if (canCreate && inRect(x, y, createPveRect)) return 'pve';
        if (canCreate && inRect(x, y, createPvpRect)) return 'pvp';
        return null;
    }
    function leaveHit(x, y) { return inRect(x, y, leaveRect); }
    function cardHit(x, y) {
        for (let i = 0; i < cardRects.length; i++) {
            if (inRect(x, y, cardRects[i])) return i;
        }
        return -1;
    }

    function charHit(x, y) { return inRect(x, y, charBtnRect); }

    function setLobbyMsg(text) {
        lobbyMsg.text = text;
    }

    // Repaints the hover-sensitive fills: the create button, the leave button
    // and every card. Called on hover changes and after a re-render, never from
    // the ticker — a background tab must not depend on a frame to look right.
    function paintLobby() {
        if (createPveRect) {
            const color = canCreate ? (hoverCreate === 'pve' ? 0xff5d78 : 0xe94560) : 0x6b2b3e;
            createPveBtn.clear()
                .roundRect(createPveRect.x, createPveRect.y, createPveRect.w, createPveRect.h,
                           Math.min(14, createPveRect.h * 0.3))
                .fill(color);
            createPveBtnText.alpha = canCreate ? 1 : 0.5;
        }

        if (createPvpRect) {
            const color = canCreate ? (hoverCreate === 'pvp' ? 0xff5d78 : 0xe94560) : 0x6b2b3e;
            createPvpBtn.clear()
                .roundRect(createPvpRect.x, createPvpRect.y, createPvpRect.w, createPvpRect.h,
                           Math.min(14, createPvpRect.h * 0.3))
                .fill(color);
            createPvpBtnText.alpha = canCreate ? 1 : 0.5;
        }

        if (leaveRect) {
            leaveBtn.clear()
                .roundRect(leaveRect.x, leaveRect.y, leaveRect.w, leaveRect.h,
                           Math.min(10, leaveRect.h * 0.3))
                .fill(0xe94560);
        }

        if (charBtnRect) {
            charBtn.clear()
                .roundRect(charBtnRect.x, charBtnRect.y, charBtnRect.w, charBtnRect.h,
                           Math.min(10, charBtnRect.h * 0.3))
                .fill(hoverCharBtn ? 0xff5d78 : 0xe94560);
        }

        if (invBtnRect) {
            invBtn.clear()
                .roundRect(invBtnRect.x, invBtnRect.y, invBtnRect.w, invBtnRect.h,
                           Math.min(10, invBtnRect.h * 0.3))
                .fill(hoverInvBtn ? 0xff5d78 : 0xe94560);
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
                text: (room.mode === 'pvp' ? 'PvP' : 'PvE') + ' · ' + statusLabel(room.status)
                    + ' · ' + (room.owner || '?')
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

    // --- character picker / page -------------------------------------------
    function statsText(info) {
        const sec = info.delayMs / 1000;
        const secStr = Number.isInteger(sec) ? String(sec) : sec.toFixed(1).replace('.', ',');
        return [
            'Здоровье: ' + info.hp,
            'Урон: ' + info.damage,
            'Скорость атаки: каждые ' + secStr + ' с',
            'Броня: ' + info.armor,
            'Крит: ' + info.critChance + '% · ×' + ((100 + info.critMult) / 100),
            'Уклонение: ' + info.dodge + '%',
            'Тип урона: ' + (info.dmgType === 'magical' ? 'магический' : 'физический'),
        ].join('\n');
    }

    function classSprite(info) {
        return info && classTextures[info.class] ? classTextures[info.class] : PIXI.Texture.WHITE;
    }

    function drawArrowButton(g, rect, dir) {
        g.clear();
        g.roundRect(rect.x, rect.y, rect.w, rect.h, Math.min(10, rect.h * 0.3)).fill(0x2a3d6b);
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const s = rect.w * 0.26;
        g.poly(dir < 0
            ? [cx + s, cy - s, cx - s, cy, cx + s, cy + s]
            : [cx - s, cy - s, cx + s, cy, cx - s, cy + s]).fill(0xffffff);
    }

    // Positions the overlay panel and its controls; called on every resize like
    // layout(). Only geometry lives here — the text and textures are set by the
    // render functions below.
    function layoutCharScene() {
        const w = app.screen.width;
        const h = app.screen.height;

        charBackdrop.clear().rect(0, 0, w, h).fill({ color: 0x0d1526, alpha: 0.72 });

        const pw = Math.min(0.62 * w, 520);
        const ph = Math.min(0.82 * h, 600);
        const px = (w - pw) / 2;
        const py = (h - ph) / 2;
        charPanelRect = { x: px, y: py, w: pw, h: ph };

        charPanel.clear().roundRect(px, py, pw, ph, Math.min(16, ph * 0.03)).fill(0x1b2744);

        charTitle.style.fontSize = Math.round(0.05 * h);
        charTitle.x = px + pw / 2;
        charTitle.y = py + ph * 0.09;

        const spriteSize = Math.min(ph * 0.26, pw * 0.42);
        charSpriteSize = spriteSize;
        charSprite.x = px + pw / 2;
        charSprite.y = py + ph * 0.30;

        charStats.style.fontSize = Math.max(12, Math.round(0.032 * h));
        charStats.anchor.set(0, 0);
        charStats.x = px + pw * 0.14;
        charStats.y = py + ph * 0.52;

        const arrowSize = Math.min(44, spriteSize * 0.55);
        arrowLeftRect = {
            x: charSprite.x - spriteSize / 2 - arrowSize - 14,
            y: charSprite.y - arrowSize / 2, w: arrowSize, h: arrowSize,
        };
        arrowRightRect = {
            x: charSprite.x + spriteSize / 2 + 14,
            y: charSprite.y - arrowSize / 2, w: arrowSize, h: arrowSize,
        };
        drawArrowButton(arrowLeft, arrowLeftRect, -1);
        drawArrowButton(arrowRight, arrowRightRect, 1);

        const bw = Math.min(pw * 0.4, 200);
        const bh = Math.round(ph * 0.09);
        actionBtnRect = { x: px + pw / 2 - bw / 2, y: py + ph - bh - ph * 0.05, w: bw, h: bh };
        charActionBtn.clear()
            .roundRect(actionBtnRect.x, actionBtnRect.y, actionBtnRect.w, actionBtnRect.h,
                       Math.min(12, actionBtnRect.h * 0.3))
            .fill(0xe94560);
        charActionBtnText.style.fontSize = Math.round(0.034 * h);
        charActionBtnText.x = actionBtnRect.x + actionBtnRect.w / 2;
        charActionBtnText.y = actionBtnRect.y + actionBtnRect.h / 2;

        const cbs = Math.min(30, Math.round(0.045 * h));
        closeBtnRect = { x: px + pw - cbs - 8, y: py + 8, w: cbs, h: cbs };
        charCloseBtn.clear()
            .roundRect(closeBtnRect.x, closeBtnRect.y, closeBtnRect.w, closeBtnRect.h,
                       Math.min(8, closeBtnRect.h * 0.3))
            .fill(0x2a3d6b);
        charCloseBtnText.style.fontSize = Math.round(cbs * 0.6);
        charCloseBtnText.x = closeBtnRect.x + closeBtnRect.w / 2;
        charCloseBtnText.y = closeBtnRect.y + closeBtnRect.h / 2;
    }

    function renderCharSelect() {
        const info = classList[charIndex];
        charTitle.text = info ? (CLASS_RU[info.class] || info.class) : '';
        charSprite.texture = classSprite(info);
        charSprite.width = charSpriteSize;
        charSprite.height = charSpriteSize;
        charSprite.visible = true;
        charStats.text = info ? statsText(info) : '';
        charActionBtnText.text = 'выбрать';
        charActionBtn.visible = charActionBtnText.visible = true;
        arrowLeft.visible = arrowRight.visible = true;
        charCloseBtn.visible = charCloseBtnText.visible = false;
    }

    function renderCharProfile() {
        const info = classList.find((c) => c.class === myCls);
        charTitle.text = 'Персонаж';
        charSprite.texture = classSprite(info);
        charSprite.width = charSpriteSize;
        charSprite.height = charSpriteSize;
        charSprite.visible = true;
        charStats.text = info ? statsText(info) : 'класс не выбран';
        charActionBtnText.text = 'restart';
        charActionBtn.visible = charActionBtnText.visible = true;
        arrowLeft.visible = arrowRight.visible = false;
        charCloseBtn.visible = charCloseBtnText.visible = true;
    }

    function openCharSelect() {
        overlay = 'select';
        if (charIndex < 0 || charIndex >= classList.length) charIndex = 0;
        renderCharSelect();
        charScene.visible = true;
    }

    function openCharProfile() {
        overlay = 'profile';
        renderCharProfile();
        charScene.visible = true;
    }

    function closeCharOverlay() {
        overlay = null;
        charScene.visible = false;
        paintLobby();
    }

    function confirmClass() {
        const info = classList[charIndex];
        if (info) net.send({ action: 'set_class', cls: info.class });
    }

    function applySetClassResult(data) {
        if (data.ok) {
            myCls = data.cls;
            closeCharOverlay();
            showLobby();
        } else {
            console.warn('set_class failed:', data.reason);
        }
    }

    // --- inventory -----------------------------------------------------------
    // The player's gear. The server sends the whole backpack and equipment after
    // every change, so the client only renders; it never applies a delta itself.
    // `invSelectedUid` is the item the description and the delete button act on,
    // tracked by uid so a tap survives the equip/unequip move it triggers.

    // hp/damage added up over every worn slot. These are the same numbers the
    // server folds into the owner's unit when a battle starts.
    function equipmentBonus() {
        let hp = 0, damage = 0;
        for (const slot of Object.keys(myEquipment)) {
            const item = myEquipment[slot];
            if (!item || typeof item !== 'object') continue;
            hp += Number(item.hp) || 0;
            damage += Number(item.damage) || 0;
        }
        return { hp, damage };
    }

    // The first item with this uid, searched in the backpack then the equipment.
    function findItemByUid(uid) {
        if (uid == null) return null;
        for (const item of myInventory) if (item && item.uid === uid) return item;
        for (const slot of Object.keys(myEquipment)) {
            const item = myEquipment[slot];
            if (item && item.uid === uid) return item;
        }
        return null;
    }

    function itemDescText(item) {
        if (!item) return 'выбери предмет — его описание появится здесь';
        const def = ITEM_DEFS[item.type];
        const parts = [def ? def.name : String(item.type)];
        if (def) parts.push('Слот: ' + (SLOT_RU[def.slot] || def.slot));
        const effects = [];
        if (Number(item.hp)) effects.push('здоровье +' + item.hp);
        if (Number(item.damage)) effects.push('урон +' + item.damage);
        if (effects.length) parts.push(effects.join(' · '));
        return parts.join('\n');
    }

    // The character column: the class base stats with the equipment bonus shown
    // in place, so what the player sees is what the next battle will use.
    function invStatsText() {
        const info = classList.find((c) => c.class === myCls);
        if (!info) return 'класс не выбран';
        const bonus = equipmentBonus();
        const sec = info.delayMs / 1000;
        const secStr = Number.isInteger(sec) ? String(sec) : sec.toFixed(1).replace('.', ',');
        return [
            'Класс: ' + (CLASS_RU[info.class] || info.class),
            'Здоровье: ' + (info.hp + bonus.hp) + (bonus.hp ? ' (+' + bonus.hp + ')' : ''),
            'Урон: ' + (info.damage + bonus.damage) + (bonus.damage ? ' (+' + bonus.damage + ')' : ''),
            'Скорость атаки: каждые ' + secStr + ' с',
            'Броня: ' + info.armor,
            'Крит: ' + info.critChance + '% · ×' + ((100 + info.critMult) / 100),
            'Уклонение: ' + info.dodge + '%',
            'Тип урона: ' + (info.dmgType === 'magical' ? 'магический' : 'физический'),
        ].join('\n');
    }

    // Puts a slot's container at (cx, cy), sizes its sprites, and records its
    // hit rectangle and size. The background is painted later by highlightSlot
    // so the selection ring can be part of the same fill.
    function placeSlot(slotObj, cx, cy, size) {
        slotObj.container.x = cx;
        slotObj.container.y = cy;
        slotObj.emptySprite.width = size * 0.88;
        slotObj.emptySprite.height = size * 0.88;
        slotObj.itemSprite.width = size * 0.88;
        slotObj.itemSprite.height = size * 0.88;
        slotObj.rect = { x: cx - size / 2, y: cy - size / 2, w: size, h: size };
        slotObj.size = size;
    }

    function highlightSlot(slotObj, on) {
        const s = slotObj.size || (slotObj.rect ? slotObj.rect.w : 1);
        slotObj.bg.clear()
            .roundRect(-s / 2, -s / 2, s, s, Math.min(8, s * 0.18))
            .fill(0x0d1526)
            .stroke({
                width: on ? Math.max(2, s * 0.07) : 2,
                color: on ? SELECT_COLOR : 0x2a3d6b,
                alpha: 0.9,
            });
    }

    function equipSlotFor(slot) {
        return equipSlots.find((es) => es.slot === slot);
    }

    // Positions the panel and every slot. Only geometry lives here; render
    // functions below set the textures, the character and the description.
    function layoutInventory() {
        const w = app.screen.width;
        const h = app.screen.height;

        invBackdrop.clear().rect(0, 0, w, h).fill({ color: 0x0d1526, alpha: 0.72 });

        const pw = Math.min(0.92 * w, 860);
        const ph = Math.min(0.88 * h, 640);
        const px = (w - pw) / 2;
        const py = (h - ph) / 2;
        invPanel.clear().roundRect(px, py, pw, ph, Math.min(16, ph * 0.03)).fill(0x1b2744);

        invTitle.style.fontSize = Math.round(0.05 * h);
        invTitle.x = px + pw / 2;
        invTitle.y = py + ph * 0.04;

        const cbs = Math.min(30, Math.round(0.045 * h));
        invCloseRect = { x: px + pw - cbs - 8, y: py + 8, w: cbs, h: cbs };
        invCloseBtn.clear()
            .roundRect(invCloseRect.x, invCloseRect.y, invCloseRect.w, invCloseRect.h,
                       Math.min(8, invCloseRect.h * 0.3))
            .fill(0x2a3d6b);
        invCloseBtnText.style.fontSize = Math.round(cbs * 0.6);
        invCloseBtnText.x = invCloseRect.x + cbs / 2;
        invCloseBtnText.y = invCloseRect.y + cbs / 2;

        // Three columns: character on the left, equipment in the middle,
        // backpack and description on the right.
        const leftX = px + pw * 0.02;
        const midX = px + pw * 0.30;
        const rightX = px + pw * 0.68;
        const leftW = pw * 0.26;
        const midW = pw * 0.38;
        const rightW = pw * 0.30;

        const charSize = Math.min(leftW * 0.8, ph * 0.22);
        invCharSprite.x = leftX + leftW / 2;
        invCharSprite.y = py + ph * 0.22;
        invCharSprite.width = charSize;
        invCharSprite.height = charSize;
        invCharName.anchor.set(0.5, 0);
        invCharName.style.fontSize = Math.round(0.032 * h);
        invCharName.x = leftX + leftW / 2;
        invCharName.y = py + ph * 0.14;
        invCharStats.anchor.set(0, 0);
        invCharStats.style.fontSize = Math.max(11, Math.round(0.026 * h));
        invCharStats.x = leftX + leftW * 0.06;
        invCharStats.y = invCharSprite.y + charSize / 2 + 0.02 * h;

        // The equipment slots in a humanoid arrangement: helmet and amulet on
        // top, weapon / body / gloves across the middle, pants and boots below,
        // then the five rings in a row.
        const slot = Math.min(midW * 0.30, ph * 0.085);
        const gap = slot * 0.24;
        const midCx = midX + midW / 2;
        const topY = py + ph * 0.15;
        const row = (n) => topY + n * (slot + gap);

        placeSlot(equipSlotFor('helmet'), midCx, row(0), slot);
        placeSlot(equipSlotFor('amulet'), midCx, row(1), slot);
        placeSlot(equipSlotFor('weapon'), midCx - slot - gap, row(2), slot);
        placeSlot(equipSlotFor('body'),   midCx, row(2), slot);
        placeSlot(equipSlotFor('gloves'), midCx + slot + gap, row(2), slot);
        placeSlot(equipSlotFor('pants'),  midCx, row(3), slot);
        placeSlot(equipSlotFor('boots'),  midCx, row(4), slot);

        const rs = Math.min(midW * 0.17, ph * 0.06);
        const rg = rs * 0.35;
        const ringW = 5 * rs + 4 * rg;
        let ringX = midCx - ringW / 2 + rs / 2;
        const ringY = row(5);
        for (let i = 0; i < 5; i++) {
            placeSlot(equipSlotFor('ring' + i), ringX, ringY, rs);
            ringX += rs + rg;
        }

        // The backpack: a 5×3 grid of 15 slots.
        const cols = 3;
        const bs = Math.min((rightW / cols) * 0.72, ph * 0.055);
        const bgap = bs * 0.35;
        const btop = py + ph * 0.15;
        const bleft = rightX + rightW / 2 - (cols * bs + (cols - 1) * bgap) / 2 + bs / 2;
        for (let i = 0; i < 15; i++) {
            placeSlot(backpackSlots[i],
                      bleft + (i % cols) * (bs + bgap),
                      btop + Math.floor(i / cols) * (bs + bgap), bs);
        }

        // The description of the selected item, the placeholder abilities panel,
        // and the delete button fill the rest of the right column.
        invDescText.anchor.set(0, 0);
        invDescText.style.fontSize = Math.max(11, Math.round(0.026 * h));
        invDescText.x = rightX + rightW * 0.05;
        invDescText.y = btop + 5 * (bs + bgap) + 0.02 * h;

        const emptyTop = py + ph * 0.80;
        const emptyH = ph * 0.13;
        invEmptyPanel.clear()
            .roundRect(rightX + rightW * 0.05, emptyTop, rightW * 0.9, emptyH,
                       Math.min(10, emptyH * 0.15))
            .fill(0x0d1526);

        const dbh = Math.min(0.05 * h, 34);
        deleteBtnRect = { x: rightX + rightW * 0.05, y: py + ph - dbh - ph * 0.04, w: rightW * 0.9, h: dbh };
        invDeleteBtn.clear()
            .roundRect(deleteBtnRect.x, deleteBtnRect.y, deleteBtnRect.w, deleteBtnRect.h,
                       Math.min(10, dbh * 0.3))
            .fill(0xe94560);
        invDeleteBtnText.style.fontSize = Math.round(0.026 * h);
        invDeleteBtnText.x = deleteBtnRect.x + deleteBtnRect.w / 2;
        invDeleteBtnText.y = deleteBtnRect.y + deleteBtnRect.h / 2;
    }

    function renderInventory() {
        const info = classList.find((c) => c.class === myCls);
        invCharName.text = myName || '';
        invCharSprite.texture = classSprite(info);
        invCharSprite.visible = true;
        invCharStats.text = invStatsText();

        // Equipment: the worn item icon, or the slot's empty silhouette.
        for (const es of equipSlots) {
            const item = myEquipment[es.slot];
            es.emptySprite.texture = emptySlotTextures[es.emptyName] || PIXI.Texture.WHITE;
            es.emptySprite.visible = true;
            es.emptySprite.alpha = item ? 0.35 : 1;
            es.itemSprite.visible = !!item;
            if (item) es.itemSprite.texture = itemTextures[item.type] || PIXI.Texture.WHITE;
            highlightSlot(es, !!item && item.uid === invSelectedUid);
        }

        // Backpack: the item icon on an otherwise plain slot.
        for (let i = 0; i < backpackSlots.length; i++) {
            const bs = backpackSlots[i];
            const item = myInventory[i];
            bs.emptySprite.visible = false;
            bs.itemSprite.visible = !!item;
            if (item) bs.itemSprite.texture = itemTextures[item.type] || PIXI.Texture.WHITE;
            highlightSlot(bs, !!item && item.uid === invSelectedUid);
        }

        updateInventoryDescription();
    }

    function updateInventoryDescription() {
        const item = findItemByUid(invSelectedUid);
        invDescText.text = itemDescText(item);
        const enabled = !!item;
        invDeleteBtn.alpha = enabled ? 1 : 0.4;
        invDeleteBtnText.alpha = enabled ? 1 : 0.4;
    }

    function openInventory() {
        overlay = 'inventory';
        renderInventory();
        invScene.visible = true;
    }

    function closeInventory() {
        overlay = null;
        invScene.visible = false;
        paintLobby();
    }

    function applyInventoryResult(data) {
        if (data.ok) {
            myInventory = Array.isArray(data.inventory) ? data.inventory : myInventory;
            myEquipment = data.equipment && typeof data.equipment === 'object' ? data.equipment : myEquipment;
            // Keep the description on the item it followed, or drop it if the
            // item is gone (deleted).
            if (invSelectedUid != null && !findItemByUid(invSelectedUid)) invSelectedUid = null;
            if (overlay === 'inventory') renderInventory();
        } else {
            console.warn('inventory action failed:', data.reason);
            invDescText.text = {
                full: 'рюкзак полон — удали что-нибудь',
                'no-auth': 'войди, чтобы играть',
                'in-room': 'снаряжение меняется только в лобби',
                empty: 'предмет уже исчез',
                'bad-request': 'сервер не понял запрос',
            }[data.reason] || 'не получилось';
        }
    }

    function applyRestartResult(data) {
        if (data.ok) {
            myCls = '';
            myInventory = Array.isArray(data.inventory) ? data.inventory : [];
            myEquipment = data.equipment && typeof data.equipment === 'object' ? data.equipment : {};
            invSelectedUid = null;
            charIndex = 0;
            openCharSelect();
        } else {
            console.warn('restart failed:', data.reason);
        }
    }

    function invHit(x, y) {
        for (const es of equipSlots) {
            if (inRect(x, y, es.rect)) return { kind: 'equip', slot: es.slot };
        }
        for (let i = 0; i < backpackSlots.length; i++) {
            if (inRect(x, y, backpackSlots[i].rect)) return { kind: 'backpack', index: i };
        }
        return null;
    }

    function tapEquipSlot(slot) {
        const item = myEquipment[slot];
        if (!item) return;
        invSelectedUid = item.uid;
        renderInventory();
        net.send({ action: 'unequip', uid: item.uid });
    }

    function tapBackpackSlot(index) {
        const item = myInventory[index];
        if (!item) return;
        invSelectedUid = item.uid;
        renderInventory();
        net.send({ action: 'equip', uid: item.uid });
    }

    function deleteSelected() {
        if (invSelectedUid == null) return;
        net.send({ action: 'delete_item', uid: invSelectedUid });
    }

    function clearBoardState() {
        lastSeq = 0;
        battleT = 0;
        selected = 0;
        shots = [];
        orders = [];
        yours = null;
        running = false;
        roomStatus = 'running';
        countdownText.visible = false;
        countdownText.text = '';
        unitsById.clear();
        for (const column of leftT) column.fill(null);
        for (const column of rightT) column.fill(null);
        shotsGfx.clear();
        ordersGfx.clear();
        abilityTargeting = false;
        abilityCdUntil = 0;
        abilityBurst = null;
        abilityPulseUntil = 0;
    }

    function showLobby() {
        screen = 'lobby';
        roomId = 0;
        amOwner = false;
        mySide = -1;
        roomMode = 'pve';
        roomOwnerName = '';
        clearBoardState();
        statusText.text = '';
        loginEl.style.display = 'none';
        boardScene.visible = false;
        lobbyScene.visible = true;
        redrawBoard();
        updateOrderHint();
    }

    function enterRoom(id, owner, ownerName, mode, side) {
        screen = 'room';
        roomId = id;
        amOwner = !!owner;
        mySide = typeof side === 'number' ? side : (owner ? 0 : -1);
        roomMode = mode || 'pve';
        roomOwnerName = ownerName || '';
        clearBoardState();
        leaveBtnText.text = '← Комната ' + id;
        hintText.text = roomMode === 'pvp' ? 'начать бой' : 'новый бой';
        circle.visible = amOwner;
        hintText.visible = amOwner;
        abilityBtn.visible = mySide >= 0;
        abilityIcon.visible = mySide >= 0;
        abilityCdGfx.visible = mySide >= 0;
        abilityCdText.visible = mySide >= 0;
        loginEl.style.display = 'none';
        boardScene.visible = true;
        lobbyScene.visible = false;
        redrawBoard();
        updateOrderHint();
    }

    function applyRoomResult(data) {
        if (data.ok && data.roomId) {
            enterRoom(data.roomId, data.owner, data.ownerName, data.mode, data.side);
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
        else if (data.action === 'ability_result') {
            applyAbilityResult(data);
        }
        else if (data.action === 'login_result') {
            applyLoginResult(data);
        }
        else if (data.action === 'set_class_result') {
            applySetClassResult(data);
        }
        else if (data.action === 'inventory_result') {
            applyInventoryResult(data);
        }
        else if (data.action === 'restart_result') {
            applyRestartResult(data);
        }
        else if (data.action === 'reset_result') {
            applyResetResult(data);
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
        if (newBattle) {
            selected = 0;
            abilityTargeting = false;
        }

        // A unit that died cannot stay picked: its id is gone from the snapshot
        // and the next order would be refused for a unit that no longer exists.
        if (selected && !unitsById.has(selected)) selected = 0;

        // Which units answer to the player. Guarded by the key, not by "is it
        // empty": an empty list is a real answer (none of ours are left), while
        // a missing one means an older server that calls the whole side ours.
        yours = Array.isArray(data.yours) ? new Set(data.yours) : null;

        // If the commanded unit died while the ability was armed, drop the arm:
        // the next enemy tap would otherwise address a unit that no longer exists.
        if (abilityTargeting && !myUnitId()) abilityTargeting = false;

        orders = data.orders || [];

        // The cooldown deadline: the snapshot's remaining time is added to the
        // wall clock, taking the longer of the side lockout and the commanded
        // unit's own cooldown. The snapshot is authoritative, so a refused cast
        // is corrected here too.
        abilityCdTotal = (data.ability && data.ability.cooldownMs) || 10000;
        let cd = typeof data.lockout === 'number' ? data.lockout : 0;
        const mineId = myUnitId();
        if (mineId) {
            const mine = unitsById.get(mineId);
            if (mine && typeof mine.cd === 'number' && mine.cd > cd) cd = mine.cd;
        }
        abilityCdUntil = performance.now() + cd;

        redrawBoard();

        shots = data.shots || [];
        roomStatus = typeof data.status === 'string' ? data.status : 'running';
        running = roomStatus === 'running';

        if (!running) {
            shots.length = 0;
            shotsGfx.clear();
            abilityTargeting = false;
        }

        // A clock jump that large is a new battle, not drift, so it is taken as
        // is. newBattle is already known above and told the pick to let go.
        battleT += newBattle ? drift : drift * 0.25;

        statusText.text = {
            left_won: 'победа синих',
            right_won: 'победа красных',
            draw: 'ничья',
        }[roomStatus] || '';

        if (roomStatus === 'waiting' || roomStatus === 'ready') {
            statusText.text = roomStatus === 'waiting'
                ? 'ждём противника…'
                : (mySide === 0 ? 'противник вошёл — жми круг' : 'готово — хозяин начинает');
        }

        countdownText.visible = roomStatus === 'countdown';
        if (countdownText.visible) {
            countdownText.text = String(Math.max(1, Math.ceil((data.countdown || 0) / 1000)));
        }

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

    // The ability button is a circle too, so its hit test is the same distance
    // check rather than a stored rectangle.
    function abilityHit(x, y) {
        const dx = x - abilityBtn.x;
        const dy = y - abilityBtn.y;
        return dx * dx + dy * dy <= abilityR * abilityR;
    }

    // Everything the page responds to starts here: the lobby when it is shown,
    // the board when a room is open.
    function onTap(e) {
        const x = e.global.x;
        const y = e.global.y;

        // The character overlay is modal on top of the lobby: while it is up,
        // taps go to its controls and nowhere else.
        if (overlay === 'select') {
            if (inRect(x, y, arrowLeftRect)) {
                charIndex = (charIndex + classList.length - 1) % classList.length;
                renderCharSelect();
            } else if (inRect(x, y, arrowRightRect)) {
                charIndex = (charIndex + 1) % classList.length;
                renderCharSelect();
            } else if (inRect(x, y, actionBtnRect)) {
                confirmClass();
            }
            return;
        }

        if (overlay === 'profile') {
            if (inRect(x, y, actionBtnRect)) {
                net.send({ action: 'restart' });
            } else if (inRect(x, y, closeBtnRect)) {
                closeCharOverlay();
            }
            return;
        }

        if (overlay === 'inventory') {
            if (inRect(x, y, invCloseRect)) {
                closeInventory();
                return;
            }
            if (inRect(x, y, deleteBtnRect)) {
                deleteSelected();
                return;
            }
            const hit = invHit(x, y);
            if (hit) {
                if (hit.kind === 'equip') tapEquipSlot(hit.slot);
                else tapBackpackSlot(hit.index);
            }
            return;
        }

        if (screen === 'lobby') {
            const createMode = createHit(x, y);
            if (createMode) {
                setLobbyMsg('создаём…');
                net.send({ action: 'create_room', mode: createMode });
                return;
            }

            if (charHit(x, y)) {
                openCharProfile();
                return;
            }

            if (inRect(x, y, invBtnRect)) {
                openInventory();
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

        if (mySide < 0) {
            flash('ты зритель — командуют игроки', false);
            return;
        }

        // The ability button toggles the targeting mode: arm, then tap an enemy
        // to cast. Tapping the button again (or empty space) cancels it.
        if (abilityHit(x, y)) {
            if (abilityTargeting) {
                abilityTargeting = false;
                paintAbility();
                updateOrderHint();
            } else if (!running) {
                flash(idleMessage(), false);
            } else if (!myUnitId()) {
                flash('твой юнит мёртв', false);
            } else if (abilityRemaining() > 0) {
                flash('способность ещё перезаряжается', false);
            } else {
                abilityTargeting = true;
                flashUntil = 0;   // the cast prompt takes over the hint band
                orderHint.style.fill = 0xffffff;
                setHint('выбери врага для способности');
                paintAbility();
            }
            return;
        }

        if (amOwner && overCircle(x, y)) {
            console.log('Круг нажат!');
            net.send({ action: 'reset' });
            return;
        }

        const cell = cellAt(x, y);

        if (abilityTargeting) {
            if (cell) {
                const unit = grids[cell.side][cell.col][cell.row];
                if (unit && cell.side === (1 - mySide)) {
                    net.send({ action: 'ability', unitId: myUnitId(), targetId: unit.id });
                    abilityTargeting = false;
                    paintAbility();
                    updateOrderHint();
                } else {
                    flash('цель — враг', false);
                }
            } else {
                abilityTargeting = false;
                paintAbility();
                updateOrderHint();
            }
            return;
        }

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
            flash(idleMessage(), false);
            return;
        }

        if (!unit) {
            if (selected) { selected = 0; redrawBoard(); updateOrderHint(); }
            return;
        }

        if (side === mySide) {
            if (!canCommand(unit)) {
                flash('этот юнит не твой — командуй подсвеченным', false);
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
        'not-commanded': 'этот юнит не твой — командуй подсвеченным',
        over: 'бой уже окончен',
        'bad-request': 'сервер не понял приказ',
    };

    function applyOrderResult(data) {
        const text = REASON_TEXT[data.reason]
            || (data.ok ? 'приказ принят' : 'приказ отклонён');
        flash(text, data.ok);
    }

    // Ability refusals have their own words, though the shape is the same as an
    // order_result. `cooldown` is the unit's own timer, `locked` the team-wide
    // window; today they coincide, but they stay separate so the text can differ.
    const ABILITY_REASON_TEXT = {
        cooldown: 'способность ещё перезаряжается',
        locked: 'команда ещё не готова к способности',
        'bad-target': 'выбери врага',
        'no-unit': 'твой юнит уже мёртв',
        'not-yours': 'это чужой юнит',
        'not-commanded': 'этот юнит не твой',
        over: 'бой уже окончен',
        'not-owner': 'командует только хозяин комнаты',
        'no-auth': 'войди, чтобы играть',
        'bad-request': 'сервер не понял способность',
    };

    function applyAbilityResult(data) {
        if (data.ok) {
            // The cast animation is local: the target is known from the tap, so
            // a burst can start at once. The snapshot then confirms the cooldown.
            const t = unitsById.get(data.targetId);
            if (t) abilityBurst = { side: t.side, col: t.col, row: t.row, until: performance.now() + FX_MS };
            abilityPulseUntil = performance.now() + FX_MS;
            abilityCdUntil = performance.now() + abilityCdTotal;
            flash('способность применена', true);
        } else {
            flash(ABILITY_REASON_TEXT[data.reason] || 'способность отклонена', false);
        }
    }

    // Why the reset circle refused, in a PvP room: the host cannot start before
    // an opponent has joined, nor while a countdown is already running.
    const RESET_REASON_TEXT = {
        waiting: 'противник ещё не вошёл',
        counting: 'обратный отсчёт уже идёт',
        'not-owner': 'командует только хозяин комнаты',
        'no-room': 'ты не в комнате',
        'no-auth': 'войди, чтобы играть',
    };

    function applyResetResult(data) {
        if (!data.ok) {
            flash(RESET_REASON_TEXT[data.reason] || 'не получилось начать', false);
        }
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

    // What to say while the fight is not running, by the room's phase. The owner
    // sees the start/restart prompt; the guest waits for the owner; a spectator
    // is handled separately in updateOrderHint.
    function idleMessage() {
        switch (roomStatus) {
            case 'waiting':   return 'ждём противника…';
            case 'ready':     return mySide === 0 ? 'противник вошёл — жми круг' : 'готово — хозяин начинает';
            case 'countdown': return 'бой начинается…';
            default:          return mySide === 0 ? 'бой окончен — круг слева начинает новый' : 'бой окончен — хозяин начнёт новый';
        }
    }

    function updateOrderHint() {
        // The reply to the last tap is still up: leave it alone until its timer
        // puts the standing hint back.
        if (performance.now() < flashUntil) return;

        if (orderHint.style.fill !== 0xffffff) orderHint.style.fill = 0xffffff;

        // A spectator sees the same board but has nothing to command.
        if (mySide < 0) {
            setHint('зритель — командуют игроки');
            return;
        }

        // The ability is armed: the standing hint yields to the cast prompt so
        // it survives the snapshots that would otherwise put it back.
        if (abilityTargeting) {
            setHint('выбери врага для способности');
            return;
        }

        if (!running) {
            setHint(idleMessage());
            return;
        }

        if (selected) {
            const ordered = orders.some((o) => o.unit === selected);
            setHint(ordered
                ? 'приказ отдан · тап по тому же врагу снимает его, по другому — меняет'
                : 'выберите цель: тап по врагу отдаёт приказ');
            return;
        }

        setHint('подсвеченный юнит — твой: тап по своему, потом по врагу');
    }

    // The ability button: a circle with the icon, a green ring while it is ready
    // and a gold one while it is armed for a target. On cooldown the icon dims
    // and a dark pie slice covers the remaining fraction, with seconds on top.
    function paintAbility() {
        const r = abilityR;
        const remaining = abilityRemaining();
        const canCast = running && myUnitId() > 0 && remaining <= 0;

        abilityBtn.clear().circle(0, 0, r).fill(0x1b2744);

        if (abilityTargeting) {
            abilityBtn.circle(0, 0, r)
                .stroke({ width: Math.max(2, r * 0.12), color: SELECT_COLOR, alpha: 0.95 });
        } else if (canCast) {
            abilityBtn.circle(0, 0, r)
                .stroke({ width: Math.max(2, r * 0.08), color: 0x2ecc71, alpha: 0.7 });
        }

        abilityIcon.alpha = canCast || abilityTargeting ? 1 : 0.35;

        abilityCdGfx.clear();
        abilityCdText.text = '';
        if (remaining > 0) {
            const frac = abilityCdTotal > 0
                ? Math.max(0, Math.min(1, remaining / abilityCdTotal)) : 0;
            if (frac > 0) {
                // A pie slice from the top, clockwise, covering the remaining
                // fraction. The radius line to the start is drawn explicitly so
                // the sector does not depend on arc() connecting it itself.
                const start = -Math.PI / 2;
                const end = start + frac * Math.PI * 2;
                abilityCdGfx.moveTo(0, 0)
                    .lineTo(r * Math.cos(start), r * Math.sin(start))
                    .arc(0, 0, r, start, end)
                    .closePath()
                    .fill({ color: 0x0d1526, alpha: 0.55 });
            }
            abilityCdText.text = (remaining / 1000).toFixed(1).replace('.', ',');
        }
    }

    // The cast animation: an expanding ring on the target tile and a pulse on
    // the button, both gone after FX_MS. Cleared and redrawn every frame.
    function drawFx() {
        fxGfx.clear();
        const now = performance.now();

        if (abilityBurst) {
            if (now < abilityBurst.until) {
                const p = (now - (abilityBurst.until - FX_MS)) / FX_MS;
                const c = cellCenter(abilityBurst.side, abilityBurst.col, abilityBurst.row);
                const r = sqX * (0.3 + 0.6 * p);
                fxGfx.circle(c.x, c.y, r)
                    .stroke({ width: Math.max(2, sqX * 0.05), color: 0xffd43b, alpha: 0.9 * (1 - p) });
            } else {
                abilityBurst = null;
            }
        }

        if (now < abilityPulseUntil) {
            const p = (now - (abilityPulseUntil - FX_MS)) / FX_MS;
            const r = abilityR * (1 + 0.5 * p);
            fxGfx.circle(abilityBtn.x, abilityBtn.y, r)
                .stroke({ width: Math.max(2, abilityR * 0.08), color: 0x9be564, alpha: 0.8 * (1 - p) });
        }
    }

    app.ticker.add((ticker) => {
        if (running) battleT += ticker.deltaMS;
        drawOrders();
        drawShots();
        drawFx();
        paintAbility();
    });

    // The renderer fires 'resize' after app.screen already holds the new size,
    // which the window event does not guarantee (listener order). resizeTo:window
    // keeps the renderer itself in step with the window.
    app.renderer.on('resize', layout);
    layout();
})();
