// WebSocket with automatic reconnect.
//
// The server closes connections with RST (SO_LINGER = 0) so that a restart frees
// the port immediately. That means a deploy always drops every open tab, and
// without reconnect the page stays frozen until the user refreshes. Here the
// socket reconnects on its own and asks for the current state once it is back.
//
// Frames on the wire are newline-terminated JSON. One frame can carry several
// messages (a TCP bridge may merge them) and a message can be split across two
// frames, so everything is fed through a buffer instead of JSON.parse(frame).

const MIN_DELAY = 1000;      // first retry after one second
const MAX_DELAY = 15000;     // never wait longer than this between attempts
const FACTOR = 2;            // 1s, 2s, 4s, 8s, then capped at 15s

export function createNetwork(url, onMessage, onOpen) {
    const encoder = new TextEncoder();

    let socket = null;
    let retryTimer = null;
    let delay = MIN_DELAY;
    let stopped = false;
    let buffer = '';

    function send(data) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            // Dropping is deliberate: the caller keeps its own state, and the
            // current state is pulled again on reconnect. A queue would replay
            // stale clicks that the server has already moved past.
            console.warn('Not connected, dropping message:', data);
            return false;
        }

        socket.send(encoder.encode(JSON.stringify(data) + '\n'));
        return true;
    }

    function handleFrame(text) {
        buffer += text;

        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);

            if (!line) continue;

            let message;
            try {
                message = JSON.parse(line);
            } catch (err) {
                console.error('Parse error:', err, line);
                continue;
            }

            onMessage(message);
        }

        // A trailing fragment may still be arriving; the next frame continues it.
    }

    function scheduleReconnect() {
        if (stopped) return;

        const wait = Math.round(delay * (0.8 + Math.random() * 0.4));
        console.log(`Reconnecting in ${wait} ms`);

        retryTimer = setTimeout(() => {
            retryTimer = null;
            connect();
        }, wait);

        delay = Math.min(delay * FACTOR, MAX_DELAY);
    }

    function connect() {
        if (stopped) return;

        // A half-open socket must not linger next to a new one.
        if (socket) {
            socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
            try {
                socket.close();
            } catch (err) {
                console.warn('Close before reconnect failed:', err);
            }
            socket = null;
        }

        buffer = '';

        const ws = new WebSocket(url);
        socket = ws;

        ws.onopen = () => {
            if (socket !== ws) return;
            console.log('Connected');
            delay = MIN_DELAY;   // a working connection resets the backoff

            // Told before the first message: the caller may need to forget
            // state that belonged to the previous connection (a restarted
            // server starts counting again).
            if (onOpen) onOpen();

            send({ action: 'get_state' });
        };

        ws.onmessage = (e) => {
            if (socket !== ws) return;
            e.data.text().then((text) => {
                if (socket !== ws) return;
                console.log('Received:', text);
                handleFrame(text);
            }).catch((err) => console.error('Read error:', err));
        };

        ws.onerror = () => {
            // Log only. onclose always follows, and that is where the retry is
            // scheduled; scheduling here too would double every attempt.
            console.warn('Socket error');
        };

        ws.onclose = (e) => {
            if (socket !== ws) return;

            socket = null;
            buffer = '';

            if (stopped) {
                console.log('Disconnected');
                return;
            }

            console.log(`Disconnected (code ${e.code}), will retry`);
            scheduleReconnect();
        };
    }

    function close() {
        stopped = true;

        if (retryTimer !== null) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }

        if (socket) {
            socket.close();
            socket = null;
        }
    }

    connect();

    return { send, close, isOpen: () => !!socket && socket.readyState === WebSocket.OPEN };
}
