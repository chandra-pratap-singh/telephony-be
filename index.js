require("dotenv").config();
const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const twilio = require("twilio");

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const app = express();
const server = http.createServer(app);

// --- Security: CORS Configuration ---
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST"],
  credentials: true,
};
app.use(cors(corsOptions));

// --- API Route for TURN Credentials ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error(" Twilio credentials are not set in the .env file.");
  process.exit(1);
}
const client = twilio(accountSid, authToken);

app.get("/get-turn-credentials", async (req, res) => {
  try {
    const token = await client.tokens.create({ ttl: 7200 }); // 2-hour TTL
    res.json({ iceServers: token.iceServers });
  } catch (error) {
    console.error("Failed to fetch TURN credentials:", error);
    res.status(500).json({ error: "Failed to get TURN credentials." });
  }
});

// --- Socket.IO Server Setup ---
const io = new Server(server, { cors: corsOptions });

// --- Helper Functions ---

/**
 * Converts a WebM recording to a WAV file using the specified codec.
 * @param {string} inputPath - Path to the input .webm file.
 * @param {string} codec - The audio codec to use (e.g., 'pcm_mulaw').
 * @returns {Promise<string>} A promise that resolves with the path to the new .wav file.
 */
// In your convertToWav function...
const convertToWav = (inputPath, codec) => {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath.replace(".webm", `-${codec}.wav`);
    const ffmpeg = spawn(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      // ✅ Add this flag to suppress informational logs
      "-loglevel",
      "error",
      "-ar",
      "8000",
      "-ac",
      "1",
      "-c:a",
      codec,
      outputPath,
    ]);

    // This will now only catch true errors
    let errorOutput = "";
    ffmpeg.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(`FFmpeg exited with code ${code}\n\nError:\n${errorOutput}`);
      }
    });
    ffmpeg.on("error", (err) => reject(err));
  });
};

/**
 * Gracefully finalizes a recording session for a given room.
 * @param {import("socket.io").Socket} socket - The socket instance for the user.
 * @param {string} roomId - The room ID of the recording to finalize.
 */
const finalizeRecording = async (socket, roomId) => {
  const recordingState = socket.recordings?.get(roomId);
  if (!recordingState) return;

  const { fileStream, webmPath } = recordingState;
  console.log(
    `[${socket.id}] Finalizing recording for room ${roomId} at ${webmPath}`
  );

  await new Promise((resolve) => fileStream.end(resolve));

  try {
    const finalWavPath = await convertToWav(webmPath, "pcm_mulaw");
    console.log(
      `[${socket.id}]  Conversion successful. Final file: ${finalWavPath}`
    );
    // Optional: Delete the temporary .webm file
    // await fs.unlink(webmPath);
  } catch (error) {
    console.error(`[${socket.id}]  Conversion failed for ${webmPath}:`, error);
  } finally {
    socket.recordings.delete(roomId);
    console.log(
      `[${socket.id}] Cleaned up recording state for room ${roomId}.`
    );
  }
};

// --- Socket Event Handlers Setup ---

/**
 * Sets up all WebRTC signaling event listeners for a socket.
 * @param {import("socket.io").Socket} socket
 */
const setupSignalingHandlers = (socket) => {
  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    console.log(`[${socket.id}] joined room ${roomId}`);
    socket.to(roomId).emit("new-peer", socket.id);
  });

  socket.on("call-offer", (offer, roomId) =>
    socket.to(roomId).emit("call-offer", offer)
  );
  socket.on("call-answer", (answer, roomId) =>
    socket.to(roomId).emit("call-answer", answer)
  );
  socket.on("ice-candidate", (candidate, roomId) =>
    socket.to(roomId).emit("ice-candidate", candidate)
  );
};

/**
 * Sets up all recording-related event listeners for a socket.
 * @param {import("socket.io").Socket} socket
 */
const setupRecordingHandlers = (socket) => {
  socket.on("start-recording", async (roomId) => {
    if (!roomId)
      return console.error(
        `[${socket.id}] 'start-recording' event missing roomId.`
      );
    console.log(" 🎙️ Recording started for room", roomId);
    if (socket.recordings.has(roomId)) await finalizeRecording(socket, roomId);

    const webmPath = path.join(
      RECORDINGS_DIR,
      `audio-${roomId}-${Date.now()}.webm`
    );
    try {
      await fs.mkdir(RECORDINGS_DIR, { recursive: true });
      const fileStream = require("fs").createWriteStream(webmPath);
      socket.recordings.set(roomId, { fileStream, webmPath, roomId });
      console.log(
        `[${socket.id}] Created filestream for room ${roomId}: ${webmPath}`
      );
    } catch (err) {
      console.error(
        `[${socket.id}] Failed to create filestream for room ${roomId}:`,
        err
      );
      socket.emit(
        "recording-error",
        `Failed to start recording for room ${roomId}.`
      );
    }
  });

  socket.on("audio-chunk", (blob, roomId) => {
    try {
      const recordingState = socket.recordings.get(roomId);
      recordingState?.fileStream.write(Buffer.from(blob));
    } catch (error) {
      console.error(
        `[${socket.id}] Failed to write audio chunk for room ${roomId}:`,
        error
      );
    }
  });

  socket.on("recording-done", (roomId) => {
    if (socket.recordings.has(roomId)) {
      finalizeRecording(socket, roomId);
    }
  });
};

/**
 * Sets up the disconnect logic for a socket.
 * @param {import("socket.io").Socket} socket
 */
const setupDisconnectHandler = (socket) => {
  socket.on("disconnect", async () => {
    console.log(`User disconnected: ${socket.id}`);

    if (socket.recordings.size > 0) {
      console.log(
        `[${socket.id}] Disconnected with ${socket.recordings.size} active recording(s). Finalizing all...`
      );
      const finalizationPromises = Array.from(socket.recordings.keys()).map(
        (roomId) => finalizeRecording(socket, roomId)
      );
      await Promise.all(finalizationPromises);
    }

    const rooms = [...socket.rooms].filter((room) => room !== socket.id);
    rooms.forEach((roomId) => {
      socket.to(roomId).emit("peer-disconnected", socket.id);
    });
  });
};

// --- Main Connection Logic ---
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Each socket gets its own Map to manage multiple recordings.
  socket.recordings = new Map();

  setupSignalingHandlers(socket);
  setupRecordingHandlers(socket);
  setupDisconnectHandler(socket);
});

// --- Start Server ---
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
