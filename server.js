import { WebSocketServer, WebSocket } from 'ws';

const port = process.env.PORT || 8080;
const wss = new WebSocketServer({
  port: 8080,
  clientTracking: true
});

wss.on('connection', function connection(ws, req) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    console.log('Missing socket key');
    ws.terminate();
  }
  ws.id = key;

  console.log('Client %s connected.', key);

  ws.on('error', console.error);

  ws.on('close', () => {
    console.log('Client %s disconnected.', key);
  });

  ws.on('message', (data, isBinary) => {
    console.log('Got message from %s, contents: %s %d', key, data, isBinary);

    // Broadcast
    // wss.clients.forEach((client) => {
    //   if (client.readyState === WebSocket.OPEN && client.id != key) {
    //     client.send(data, { binary: isBinary });
    //   }
    // });
  });
});

console.log("Started on port", port);
