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

// Contains all active socket connections to the server
const connections = new Set();
// Contains all active socket connections subscribed to live transcription
const subLiveTrans = new Set();
// Contains all active socket connections subscribed scam detection
const subScamDetect = new Set();

function purgeConnection(connectionId) {
  connections.delete(connectionId);
  subLiveTrans.delete(connectionId);
  subScamDetect.delete(connectionId);
}

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

// Last processed media payload sequence number
let lastSeqNum;
// Queue of unprocessed audio chunks keyed by sequence number
let outOfOrderChunks = new Map();
// Threshold for lost packets recovery, if out of order queue reaches size reaches this value it will force
// processing starting from the min sequence number contained in the queue
const outOfOrderThreshold = 25;
// Last text that was broadcast to `live` channel subscribers
let lastTranscribeBroadcast;

// Counter of received media payloads
let mediaCounter = 0;
// Full text of transcription so far minus the currently in progress recognition
let transcription;
// Text of transcription for current in progress recognition
let inProgressTranscription;

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
    purgeConnection(connectionId);
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
  await broadcast(apiClient, connections, req.body.payload.msg);
  res.sendStatus(200);
});

app.put('/sub', (req, res) => {
  const connectionId = req.body.connectionId;
  if (!connectionId) {
    return res.status(400).send('connectionId missing');
  }

  if (!req.body.payload || !req.body.payload.channel) {
    return res.status(400).send('channel missing');
  }
  
  switch (req.body.payload.channel) {
  case 'live':
    subLiveTrans.add(connectionId);
    return res.status(200).send('subscribed to live voice transcription');
  case 'scam':
    subScamDetect.add(connectionId);
    return res.status(200).send('subscribed to scam detection');
  default:
    return res.status(400).send('unexpected channel type, supported values are "live" and "scam"');
  }
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

async function broadcast(apiClient, connections, msg) {
  for (const connectionId of connections) {
    const command = new PostToConnectionCommand({ ConnectionId: connectionId, Data: msg });
    try {
      await apiClient.send(command);
    } catch (error) {
      console.error(`Failed to broadcast message with error: ${error}`);
    }
  }
}

// Audio stream helpers

function streamConnected(req) {
  console.debug('Call connected, initializing Vosk model...');
  voskModel = new VoskModel(modelPath);
  voskRecognizer = new Recognizer({ model: voskModel, sampleRate: voskSampleRate });
  streamApiClient = makeApiClient(req);

  lastSeqNum = undefined;
  outOfOrderChunks = new Map();
  lastTranscribeBroadcast = undefined;

  mediaCounter = 0;
  transcription = '';
  inProgressTranscription = '';
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

  const seqNum = parseInt(req.body.payload.sequenceNumber);
  if (isNaN(seqNum)) {
    console.error('Media sequence number is NaN');
    return;
  }
  const audioData = req.body.payload.media.payload;
  
  mediaCounter += 1;
  if (mediaCounter % 1000 == 0) {
    console.debug(`Got seqNum: ${seqNum}, last one is: ${lastSeqNum}, queued: ${outOfOrderChunks.size}`);
  }

  if (isNextChunk(seqNum)) {
    const results = processMedia(seqNum, audioData);
    for (const text of results) {
      if (text != lastTranscribeBroadcast) {
        lastTranscribeBroadcast = text;
        await broadcast(streamApiClient, subLiveTrans, text);
      }
    }
  } else {
    if (seqNum > lastSeqNum) {
      // Only care about future chunks that will be processed, not late ones coming in after we already moved past
      outOfOrderChunks.set(seqNum, audioData);
    }
  }

  if (outOfOrderChunks.size >= outOfOrderThreshold) {
    // Out of order queue is getting filled up, sequential chunk might have been lost
    // Find the earliest queued chunk that's after the last processed one and resume from there
    let minSeqNum = Number.MAX_SAFE_INTEGER;
    const keys = outOfOrderChunks.keys();
    for (const key of keys) {
      if (key < lastSeqNum) {
        // This chunk has been skipped over, drop it
        outOfOrderChunks.delete(key);
      } else if (key < minSeqNum) {
        minSeqNum = key;
      }
    }

    if (minSeqNum == Number.MAX_SAFE_INTEGER) {
      console.debug('Dropped all out of order chunks');
      return;
    }

    console.debug(`Out of order threshold hit, last processed: ${lastSeqNum}, min queued: ${minSeqNum}, queued: ${outOfOrderChunks.size}`);
    const minAudioData = outOfOrderChunks.get(minSeqNum);
    outOfOrderChunks.delete(minSeqNum);
    
    const results = processMedia(seqNum, audioData);
    for (const text of results) {
      if (text != lastTranscribeBroadcast) {
        lastTranscribeBroadcast = text;
        await broadcast(streamApiClient, subLiveTrans, text);
      }
    }
  }

  if (mediaCounter % 100 == 0) {
    const textSoFar = transcription + inProgressTranscription;
    await broadcast(streamApiClient, subScamDetect, textSoFar);
  }
}

function isNextChunk(seqNum) {
  if (!lastSeqNum) {
    // First chunk
    return true;
  }

  const expectedSeqNum = lastSeqNum + 1;
  if (seqNum == expectedSeqNum) {
    return true;
  }

  return false;
}

function processMedia(seqNum, audioData) {
  let isDone = false
  let results = [];

  let workingSeqNum = seqNum;
  let workingAudioData = audioData;

  while (!isDone) {
    const result = transcribeChunk(workingAudioData);
    if (result.text && result.text.length > 0) {
      results.push(result.text);

      if (result.isPartial) {
        inProgressTranscription = result.text;
      } else {
        transcription += `${result.text}\n`;
        inProgressTranscription = '';
      }
    }

    workingAudioData = outOfOrderChunks.get(workingSeqNum + 1);
    if (workingAudioData) {
      workingSeqNum += 1;
      outOfOrderChunks.delete(workingSeqNum);
    } else {
      lastSeqNum = workingSeqNum;
      isDone = true;
    }
  }

  return results;
}

function transcribeChunk(audioData) {
  const samples = getSamples(audioData);
  if (voskRecognizer.acceptWaveform(samples)) {
    return {
      text: voskRecognizer.result().text,
      isPartial: false
    };
  } else {
    return {
      text: voskRecognizer.partialResult().partial,
      isPartial: true
    };
  }
}

function streamStop(req) {
  const payload = req.body.payload;
  console.debug(`Stopping stream with ID: ${payload.streamSid}`);
  voskRecognizer = null;
  voskModel = null;
  streamApiClient = null;

  lastSeqNum = undefined;
  outOfOrderChunks = new Map();
  lastTranscribeBroadcast = undefined;

  transcription = undefined;
  inProgressTranscription = undefined;
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
