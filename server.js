import { WebSocketServer, WebSocket } from 'ws';

const port = process.env.PORT || 8080;
const wss = new WebSocketServer({
  port: 8080,
  clientTracking: true
});

wss.on('connection', (ws, req) => {
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

  ws.on('message', (data) => {
    const result = transcribeAudioStream(data);
    if (result) {
      broadcastMessage(result, key);
    }
  });
});

function transcribeAudioStream(data) {
  try {
    const json = JSON.parse(data);
    return json.sequenceNumber;
  } catch (e) {
    console.log('Not JSON message: %s', data);
    return null;
  }
}

function broadcastMessage(message, keyToIgnore) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.id != keyToIgnore) {
      client.send(message);
    }
  });
}

console.log("Started on port", port);
