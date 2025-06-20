const express = require("express");
const { v4 } = require("uuid");
const fs = require("fs");
const app = express();

const cors = require("cors");
app.use(
  cors({
    origin: "http://localhost:5173", // Vite's default port
    methods: ["GET", "POST"],
    credentials: true,
  })
);

app.get("/", (req, res) => {
  res.send("hello world");
});

const serverWithSocket = app.listen(process.env.PORT || 3000, () => {
  console.log(`App running on port ${process.env.PORT || 3000}`);
});
const io = require("socket.io")(serverWithSocket, {
  cors: {
    origin: "http://localhost:5173", // Vite's default port
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const fileStreams = {};

io.on("connection", (socket) => {
  console.log("a user connected");

  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    console.log(`user ${socket.id} joined room ${roomId}`);
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
    const filePath = `recordings/audio-${socket.id}.webm`;

    if (!fileStreams[socket.id]) {
      // Create directory if not exists
      if (!fs.existsSync("recordings")) {
        fs.mkdirSync("recordings");
      }
      // Create a new write stream
      fileStreams[socket.id] = fs.createWriteStream(filePath);
      console.log(`Started recording audio for ${socket.id}`);
    }

    fileStreams[socket.id].write(Buffer.from(blob));
  });

  socket.on("recording-done", () => {
    if (fileStreams[socket.id]) {
      fileStreams[socket.id].end();
      console.log(`Recording complete for ${socket.id}`);
      delete fileStreams[socket.id];
    }
  });

  socket.on("disconnect", () => {
    console.log("user disconnected");
    const rooms = Array.from(socket.rooms);
    rooms.forEach((roomId) => {
      if (roomId !== socket.id) {
        socket.to(roomId).emit("peer-disconnected", socket.id);
      }
    });

    if (fileStreams[socket.id]) {
      fileStreams[socket.id].end();
      console.log(`Recording auto-closed for ${socket.id}`);
      delete fileStreams[socket.id];
    }
  });
});
