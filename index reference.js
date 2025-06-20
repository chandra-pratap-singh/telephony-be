const express = require("express");
const { v4 } = require("uuid");
const app = express();

const cors = require("cors");
app.use(cors({
  origin: "http://localhost:5173", // Vite's default port
  methods: ["GET", "POST"],
  credentials: true
}));

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
      credentials: true
    }
  });

  io.on("connection", (socket) => {
    console.log("a user connected");

    socket.on("join-room", (roomId) => {
      socket.join(roomId);
      console.log(`user ${socket.id} joined room ${roomId}`);
      socket.to(roomId).emit('new-peer', socket.id);
    });

    socket.on('call-offer', async (offer, roomId) => {
      socket.to(roomId).emit('call-offer', offer);
    });

    socket.on('call-answer', async (answer, roomId) => {
      socket.to(roomId).emit('call-answer', answer);
    });

    socket.on('ice-candidate', async (candidate, roomId) => {
      socket.to(roomId).emit('ice-candidate', candidate);
    });
    
    socket.on("disconnect", () => {
      console.log("user disconnected");
      const rooms = Array.from(socket.rooms);
      rooms.forEach(roomId => {
        if (roomId !== socket.id) {
          socket.to(roomId).emit('peer-disconnected', socket.id);
        }
      });
    });
  });
