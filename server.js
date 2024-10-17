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
if (!process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
  console.error('Container credentials missing');
}

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
  await broadcastMessage(req, req.body.payload.msg);
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
    streamConnected();
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
  const apiClient = makeApiClient(req);
  const connectionId = req.body.connectionId;
  const command = new DeleteConnectionCommand({
    ConnectionId: connectionId
  });
  try {
    await apiClient.send(command);
  } catch (error) {
    console.error(`Failed to kill connection ${connectionId}, error: ${error}`);
  }
}

async function broadcastMessage(req, msg) {
  const apiClient = makeApiClient(req);
  const myConnectionId = req.body.connectionId;

  for (const connectionId of connections) {
    if (connectionId != myConnectionId) {
      const command = new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: msg
      });
      try {
        await apiClient.send(command);
      } catch (error) {
        console.error(`Failed to broadcast message with error: ${error}`);
      }
    }
  }
}

// Audio stream helpers

function streamConnected() {
  console.debug('Call connected, initializing Vosk model...');
  voskModel = new VoskModel(modelPath);
  voskRecognizer = new Recognizer({ model: voskModel, sampleRate: voskSampleRate })
}

async function streamStart(req) {
  const payload = req.body.payload;
  console.debug(`Starting stream with ID: ${payload.streamSid}`);
  inboundStreamMediaFormat = parseInboundStreamMediaFormat(payload);
  if (!parseInboundStreamMediaFormat) {
    await killWebSocketConnection(req);
  }
}

const bufferSizeFlush = 10;
let audioBuffer = [];
let audioBufferSeqOffset;
let outOfOrderAudioChunks = new Map();

let debugAudioBuffer = [];
let debugOutOfOrderAudioChunks = new Set();

async function streamMedia(req) {
  const payload = req.body.payload;

  const seqNum = payload.sequenceNumber;
  const audioData = payload.media.payload;

  if (audioBuffer.length == 0) {
    audioBuffer.push(audioData);
    audioBufferSeqOffset = seqNum;

    //
    debugAudioBuffer.push(seqNum);

    return;
  }

  const nextSeqNum = audioBuffer.length + audioBufferSeqOffset;
  if (nextSeqNum == seqNum) {
    audioBuffer.push(audioData);

    //
    debugAudioBuffer.push(seqNum);

    fillOutOfOrderChunks();
    await maybeFlushAudioBuffer();
  } else {
    outOfOrderAudioChunks.set(seqNum, audioData);
    
    //
    debugOutOfOrderAudioChunks.add(seqNum);
  }
}

function fillOutOfOrderChunks() {
  let isDone = false;
  while (!isDone) {
    const nextSeqNum = audioBuffer.length + audioBufferSeqOffset;
    const nextValue = outOfOrderAudioChunks.get(nextSeqNum);
    if (nextValue) {
      audioBuffer.push(nextValue);
      outOfOrderAudioChunks.delete(nextSeqNum);

      //
      debugAudioBuffer.push(nextSeqNum);
      debugOutOfOrderAudioChunks.delete(nextSeqNum);
    } else {
      isDone = true;
    }
  }
}

async function maybeFlushAudioBuffer() {
  if (audioBuffer.length < bufferSizeFlush) {
    return false;
  }

  const audioData = audioBuffer.reduce(
    (state, value) => state + value,
    ""
  );
  audioBufferSeqOffset += audioBuffer.length;
  audioBuffer = [];

  //
  console.debug(`Flushing: ${debugAudioBuffer}`);
  debugAudioBuffer = [];

  // const result = getTranscription(audioData);
  // if (result && result != lastTranscribeBroadcast) {
  //   lastTranscribeBroadcast = result;
  //   await broadcastMessage(req, result);
  // }

  return true;
}

function streamStop(req) {
  const payload = req.body.payload;
  console.debug(`Stopping stream with ID: ${payload.streamSid}`);
  voskRecognizer = null;
  voskModel = null;
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

function getSamples(payload) {
  const buf = Buffer.from(payload, 'base64');
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

function getTranscription(mediaPayload) {
  const samples = getSamples(mediaPayload);
  if (voskRecognizer.acceptWaveform(samples)) {
    const result = voskRecognizer.result();
    return result.text;
  } else {
    const result = voskRecognizer.partialResult();
    return result.partial;
  }
}

// server.listen(port, () => {
//   console.log("Listening on port", port);
// });

function printDebugState(seqNum) {
  console.debug(`Iteration: ${seqNum}`);
  console.debug(debugAudioBuffer);
  console.debug(debugOutOfOrderAudioChunks);
  console.log();
}

function makeMockReq(seqNum) {
  return ;
}

const testData = [3, 4, 6, 5, 7, 8, 10, 11, 12, 9, 13, 16, 15, 17, 14];
for (const seqNum of testData) {
  streamMedia({
    body: {
      payload: {
        sequenceNumber: seqNum,
        media: {
          payload: "a"
        }
      }
    }
  });
  printDebugState(seqNum);
}
