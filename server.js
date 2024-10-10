// Audio stream processing
import { Buffer } from 'buffer';
import { existsSync as filePathExists } from 'fs';
import { Model as VoskModel, Recognizer } from 'vosk';
import wavefilepkg from 'wavefile';
const { WaveFile } = wavefilepkg;

// Server
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const port = process.env.PORT || 8080;

const app = express();

app.use('/health', (req, res) => {
  res.status(200).send('OK');
});

const server = http.createServer(app);

const modelPath = 'model';
if (!filePathExists(modelPath)) {
  throw Error('Vosk model cannot be found.');
}
const voskModel = new VoskModel(modelPath);

const wss = new WebSocketServer({
  clientTracking: true,
  noServer: true
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
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

  const rec = new Recognizer({ model: voskModel, sampleRate: 16000 })
  var lastBroadcast;

  ws.on('message', (data) => {
    try {
      const json = JSON.parse(data);
      if (json.action) {
        handleAction(json, ws, key);
      } else if (json.streamSid) {
        // Twilio audio stream message
        const result = transcribeAudioStream(json, rec);
        if (result && result != lastBroadcast) {
          lastBroadcast = result;
          broadcastMessage(result, key);
        }
      } else {
        console.log('Unexpected JSON payload');
      }
    } catch (e) {
      console.log('Not JSON message: %s', data);
    }
  });
});

function handleAction(json, ws, keyToIgnore) {
  switch (json.action) {
  case 'ping':
    ws.send(new Date().toISOString());
    break;

  case 'broadcast':
    if (json.msg) {
      broadcastMessage(json.msg, keyToIgnore);
    } else {
      console.log('msg field missing for broadcast');
    }
    break;

  default:
    console.log('Unknown action ${json.action}');
  }
}

function transcribeAudioStream(json, rec) {
  if (json.event == 'start') {
    console.log('Audio stream starting');
  } else if (json.event == 'stop') {
    console.log('Audio stream stopped');
  } else if (json.event == 'media') {
    const samples = getSamples(json.media.payload);
    if (rec.acceptWaveform(samples)) {
      const result = rec.result();
      return result.text;
    } else {
      const result = rec.partialResult();
      return result.partial;
    }
  }
  return null;
}

function getSamples(payload) {
  const buf = Buffer.from(payload, 'base64');
  const wav = new WaveFile();
  wav.fromScratch(1, 8000, '8m', buf);
  wav.fromMuLaw();
  wav.toSampleRate(16000);
  return wav.data.samples;
}

function broadcastMessage(message, keyToIgnore) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.id != keyToIgnore) {
      client.send(JSON.stringify(message));
    }
  });
}

server.listen(port, () => {
  console.log("Listening on port", port);
});
