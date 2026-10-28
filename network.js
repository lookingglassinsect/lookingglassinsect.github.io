    export function createNetwork(url, onMessage) {
        const ws = new WebSocket(url);
        const encoder = new TextEncoder();

        function send(data) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(encoder.encode(JSON.stringify(data)));
            }
        }

        ws.onopen = () => {
            console.log('Connected');
            send({ action: 'get_state' });
        };

        ws.onclose = () => console.log('Disconnected');

        ws.onmessage = (e) => {
            e.data.text().then((text) => {
                console.log('Received:', text);
                try {
                    onMessage(JSON.parse(text));
                } catch (err) {
                    console.error('Parse error:', err);
                }
            });
        };

        return { send };
    }