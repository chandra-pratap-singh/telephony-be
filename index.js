const express = require("express");
const fs = require("fs");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const path = require("path");

const app = express();
app.use(
  cors({
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true,
  })
);

app.get("/", (req, res) => res.send("hello world"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const fileStreams = {};

io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);
    socket.to(roomId).emit("new-peer", socket.id);
  });

  socket.on("call-offer", (offer, roomId) => {
    socket.to(roomId).emit("call-offer", offer);
  });

  socket.on("call-answer", (answer, roomId) => {
    socket.to(roomId).emit("call-answer", answer);
  });

  socket.on("ice-candidate", (candidate, roomId) => {
    socket.to(roomId).emit("ice-candidate", candidate);
  });

  socket.on("audio-chunk", (blob) => {
    const dir = "recordings";
    const webmPath = path.join(dir, `audio-${socket.id}.webm`);

    if (!fileStreams[socket.id]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      fileStreams[socket.id] = fs.createWriteStream(webmPath);
      console.log(`🎙️ Started recording: ${webmPath}`);
    }

    fileStreams[socket.id].write(Buffer.from(blob));
  });

  socket.on("recording-done", () => {
    const webmPath = `recordings/audio-${socket.id}.webm`;
    const wavPath = `recordings/audio-${socket.id}.wav`;

    const writer = fileStreams[socket.id];
    if (!writer) return;

    writer.end(() => {
      console.log(
        `🛑 Finished recording for ${socket.id}, converting to WAV...`
      );

      const gsmPath = `recordings/audio-${socket.id}.gsm`;
      const alawWavPath = `recordings/audio-${socket.id}-alaw.wav`;
      const mulawWavPath = `recordings/audio-${socket.id}-mulaw.wav`;

      const ffmpeg = spawn(ffmpegPath, [
        "-y",
        "-i",
        webmPath,
        "-ar",
        "8000",
        "-ac",
        "1",
        "-c:a",
        "pcm_mulaw", // Mu-Law codec
        mulawWavPath, // output: e.g., recordings/audio-xxx-mulaw.wav
      ]);

      ffmpeg.stderr.on("data", (data) => {
        console.error("FFmpeg error:", data.toString());
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          console.log(`✅ WAV file saved: ${alawWavPath}`);
        } else {
          console.error(`❌ FFmpeg exited with code ${code}`);
        }
      });
    });

    delete fileStreams[socket.id];
  });

  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    const writer = fileStreams[socket.id];
    if (writer) {
      writer.end();
      delete fileStreams[socket.id];
      console.log(`🧹 Cleaned up writer for ${socket.id}`);
    }

    socket.rooms.forEach((roomId) => {
      if (roomId !== socket.id) {
        socket.to(roomId).emit("peer-disconnected", socket.id);
      }
    });
  });
});

server.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});
