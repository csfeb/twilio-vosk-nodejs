import { Buffer } from 'buffer';
import { existsSync as filePathExists } from 'fs';
import { Model as VoskModel, Recognizer } from 'vosk';
import wavefilepkg from 'wavefile';
const { WaveFile } = wavefilepkg;
import { WebSocketServer, WebSocket } from 'ws';

const modelPath = 'model';
if (!filePathExists(modelPath)) {
  throw Error('Vosk model cannot be found.');
}
const voskModel = new VoskModel(modelPath);

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

  const rec = new Recognizer({ model: voskModel, sampleRate: 16000 })

  ws.on('message', (data) => {
    const result = transcribeAudioStream(data, rec);
    if (result) {
      broadcastMessage(result, key);
    }
  });
});

function transcribeAudioStream(data, rec) {
  try {
    const json = JSON.parse(data);
    if (json.event == 'start') {
      console.log('Audio stream starting');
    } else if (json.event == 'stop') {
      console.log('Audio stream stopped');
    } else if (json.event == 'media') {
      const buf = Buffer.from(json.media.payload, 'base64');
      const wav = new WaveFile();
      wav.fromScratch(1, 8000, '8m', buf);
      wav.fromMuLaw();
      wav.toSampleRate(16000);
      if (rec.acceptWaveform(wav.data.samples)) {
        const result = rec.result();
        console.log(result);
        return result.text;
      } else {
        const result = rec.partialResult();
        console.log(result);
        return result.partial;
      }
    }
  } catch (e) {
    console.log('Not JSON message: %s', data);
  }
  return null;
}

function broadcastMessage(message, keyToIgnore) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.id != keyToIgnore) {
      client.send(JSON.stringify(message));
    }
  });
}

console.log("Started on port", port);
