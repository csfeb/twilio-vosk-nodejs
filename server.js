// Audio stream processing
import { Buffer } from 'buffer';
import { existsSync as filePathExists } from 'fs';
import { Model as VoskModel, Recognizer } from 'vosk';
import wavefilepkg from 'wavefile';
const { WaveFile } = wavefilepkg;

// AWS
import { 
  ApiGatewayManagementApiClient, 
  PostToConnectionCommand, 
  DeleteConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

// Server
import bodyParser from 'body-parser';
import express from 'express';
import http from 'http';

const port = process.env.PORT || 3000;
const isLocal = !process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;

const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.writeHead(200, {'Content-Type': 'text/html'});
  const html = '<html><body><h1>Twilio + vosk + nodejs prototype server</h1></body></html>';
  res.end(html);
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const server = http.createServer(app);
const connections = new Set();

const modelPath = 'model';
if (!filePathExists(modelPath)) {
  throw Error('Vosk model cannot be found.');
}

// Audio stream
const voskSampleRate = 16000;
let voskModel;
let voskRecognizer;
let streamApiClient;
let inboundStreamMediaFormat = {};
let lastTranscribeBroadcast;

// Routes

app.post('/connect', (req, res) => {
  const connectionId = req.body.connectionId;
  if (!connectionId) {
    return res.status(400).send('connectionId missing');
  }
  connections.add(connectionId);
  console.debug(`Client ${connectionId} connected`);
  res.sendStatus(200);
});

app.post('/disconnect', (req, res) => {
  const connectionId = req.body.connectionId;
  if (connectionId) {
    connections.delete(connectionId);
    console.debug(`Client ${connectionId} disconnected`);
  } else {
    console.error('Client without a connectionId disconnected');
  }
  res.sendStatus(200);
});

// Send a message to all other clients
app.put('/send', async (req, res) => {
  if (!req.body.payload || !req.body.payload.msg) {
    console.error('/send msg missing');
    return res.status(400).send('msg missing');;
  }

  console.debug(`Active connection count: ${connections.size}`);
  const apiClient = makeApiClient(req);
  const myConnectionId = req.body.connectionId;
  await broadcast(apiClient, myConnectionId, req.body.payload.msg);
  res.sendStatus(200);
});

app.put('/default', async (req, res) => {
  const connectionId = req.body.connectionId;
  if (!connectionId) {
    console.error('/default connectionId missing');
    return res.status(400).send('connectionId missing');
  }

  if (!req.body.payload) {
    console.error('/default payload missing');
    return res.status(400).send('payload missing');
  }

  const payload = req.body.payload;
  if (payload.event == 'connected' && payload.protocol == 'Call') {
    streamConnected(req);
  } else if (payload.event == 'start') {
    await streamStart(req);
  } else if (payload.event == 'media') {
    await streamMedia(req);
  } else if (payload.event == 'stop') {
    streamStop(req);
  } else {
    console.debug(`Unknown payload sent to $default route: ${JSON.stringify(payload)}`);
  }

  res.sendStatus(200);
});

// Socket communication helpers

function makeApiClient(req) {
  if (!req.body.domainName) {
    console.error('domainName missing');
    return null;
  }

  if (!req.body.stage) {
    console.error('stage missing');
    return null;
  }

  const callbackUrl = `https://${req.body.domainName}/${req.body.stage}`;
  const client = new ApiGatewayManagementApiClient({ endpoint: callbackUrl });
  return client;
}

async function killWebSocketConnection(req) {
  const apiClient = streamApiClient || makeApiClient(req);
  const connectionId = req.body.connectionId;
  const command = new DeleteConnectionCommand({ ConnectionId: connectionId });
  try {
    await apiClient.send(command);
  } catch (error) {
    console.error(`Failed to kill connection ${connectionId}, error: ${error}`);
  }
}

async function broadcast(apiClient, myConnectionId, msg) {
  for (const connectionId of connections) {
    if (connectionId != myConnectionId) {
      const command = new PostToConnectionCommand({ ConnectionId: connectionId, Data: msg });
      try {
        await apiClient.send(command);
      } catch (error) {
        console.error(`Failed to broadcast message with error: ${error}`);
      }
    }
  }
}

// Audio stream helpers

function streamConnected(req) {
  console.debug('Call connected, initializing Vosk model...');
  voskModel = new VoskModel(modelPath);
  voskRecognizer = new Recognizer({ model: voskModel, sampleRate: voskSampleRate });
  streamApiClient = makeApiClient(req);
}

async function streamStart(req) {
  const payload = req.body.payload;
  console.debug(`Starting stream with ID: ${payload.streamSid}`);
  inboundStreamMediaFormat = parseInboundStreamMediaFormat(payload);
  if (!parseInboundStreamMediaFormat) {
    await killWebSocketConnection(req);
  }
}

async function streamMedia(req) {
  if (!voskRecognizer) {
    return;
  }

  const audioData = req.body.payload.media.payload;
  const samples = getSamples(audioData);
  let result;
  if (voskRecognizer.acceptWaveform(samples)) {
    result = voskRecognizer.result().text;
  } else {
    result = voskRecognizer.partialResult().partial;
  }

  if (result != lastTranscribeBroadcast) {
    lastTranscribeBroadcast = result;
    await broadcast(streamApiClient, req.body.connectionId, result);
  }
}

function streamStop(req) {
  const payload = req.body.payload;
  console.debug(`Stopping stream with ID: ${payload.streamSid}`);
  voskRecognizer = null;
  voskModel = null;
  streamApiClient = null;
}

function parseInboundStreamMediaFormat(payload) {
  if (!payload.start.mediaFormat) {
    console.error('Missing mediaFormat');
    return null;
  }

  if (payload.start.mediaFormat.encoding != 'audio/x-mulaw') {
    console.error(`Unexpected media encoding: ${payload.start.mediaFormat.encoding}`);
    return null;
  }

  return {
    channels: payload.start.mediaFormat.channels,
    sampleRate: payload.start.mediaFormat.sampleRate,
    bitDepth: '8m'
  };
}

function getSamples(mediaPayload) {
  const buf = Buffer.from(mediaPayload, 'base64');
  const wav = new WaveFile();
  wav.fromScratch(
    inboundStreamMediaFormat.channels,
    inboundStreamMediaFormat.sampleRate,
    inboundStreamMediaFormat.bitDepth,
    buf
  );
  wav.fromMuLaw();
  wav.toSampleRate(voskSampleRate);
  return wav.data.samples;
}

server.listen(port, () => {
  console.log("Listening on port", port);
});
