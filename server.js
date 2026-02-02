const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');
const levenshtein = require('levenshtein'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// DATA STORAGE
let players = {}; 
let gameQueue = []; 
let submittedPlayers = new Set(); 
let gameState = 'lobby'; 
let currentRoundIndex = 0;
let roundTimer = null;
let roundWinners = new Set(); // Track who answered correctly this round

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('joinGame', (name) => {
        players[socket.id] = {
            id: socket.id,
            name: name || `Player ${socket.id.substr(0,4)}`,
            score: 0,
            hasSubmitted: false
        };
        io.emit('playerJoined', {
            players: players,
            hostId: Object.keys(players)[0],
            submittedPlayers: Array.from(submittedPlayers)
        });
    });

    socket.on('searchSongs', async (query) => {
        try {
            const response = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=5`);
            const results = response.data.results.map(track => ({
                trackName: track.trackName,
                artistName: track.artistName,
                previewUrl: track.previewUrl,
                albumArt: track.artworkUrl100
            }));
            socket.emit('searchResults', results);
        } catch (error) { console.error(error); }
    });

    socket.on('submitSong', (song) => {
        if (!players[socket.id]) return;
        song.submitterId = socket.id;
        song.submitterName = players[socket.id].name;
        
        gameQueue.push(song);
        submittedPlayers.add(socket.id);
        players[socket.id].hasSubmitted = true;

        const totalPlayers = Object.keys(players).length;
        const totalSubmitted = submittedPlayers.size;
        
        io.emit('songSubmitted', {
            players: players,
            submittedPlayers: Array.from(submittedPlayers),
            isReady: totalSubmitted === totalPlayers && totalPlayers > 0
        });
    });

    socket.on('startGame', () => {
        gameState = 'playing';
        currentRoundIndex = 0;
        gameQueue = gameQueue.sort(() => Math.random() - 0.5);
        io.emit('gameStarted', { trackCount: gameQueue.length });
        setTimeout(startRound, 3000);
    });

    // --- GUESSING LOGIC ---
    socket.on('submitGuess', (guess) => {
        if (gameState !== 'playing' || !gameQueue[currentRoundIndex]) return;

        // 1. Prevent Point Farming (Already guessed?)
        if (roundWinners.has(socket.id)) {
            socket.emit('guessResult', { correct: true, points: 0, message: "You already got this one!" });
            return;
        }

        const currentTrack = gameQueue[currentRoundIndex];
        
        // 2. Prevent cheating (Guessing own song)
        if (socket.id === currentTrack.submitterId) {
             socket.emit('guessResult', { correct: false, message: "You can't guess your own song!" });
             return;
        }

        // 3. CLEAN UP (Lowercase + Remove Punctuation)
        const clean = (str) => (str || "").toLowerCase().replace(/[^\w\s]/gi, '').trim();
        
        const userGuess = clean(guess);
        const title = clean(currentTrack.trackName);
        const artist = clean(currentTrack.artistName);

        // 4. CHECK MATCH (Exact or Fuzzy)
        const isTitleMatch = (userGuess.length > 2 && title.includes(userGuess)) || userGuess === title;
        const isArtistMatch = (userGuess.length > 2 && artist.includes(userGuess)) || userGuess === artist;
        
        // Levenshtein (Typo Tolerance)
        const titleDist = new levenshtein(userGuess, title).distance;
        const allowedTypos = Math.max(2, Math.floor(title.length * 0.3));

        if (isTitleMatch || isArtistMatch || titleDist <= allowedTypos) {
            // CORRECT!
            players[socket.id].score += 10;
            if(players[currentTrack.submitterId]) players[currentTrack.submitterId].score += 2;
            
            roundWinners.add(socket.id); // Mark as winner for this round
            socket.emit('guessResult', { correct: true, points: 10 });
        } else {
            // WRONG!
            socket.emit('guessResult', { correct: false });
        }
    });
    
    socket.on('playAgain', () => {
        gameQueue = [];
        submittedPlayers.clear();
        roundWinners.clear();
        Object.values(players).forEach(p => p.hasSubmitted = false);
        gameState = 'lobby';
        io.emit('playAgainStarted');
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        submittedPlayers.delete(socket.id);
        roundWinners.delete(socket.id);
        
        const remainingIds = Object.keys(players);
        if (remainingIds.length > 0) {
             io.emit('playerJoined', {
                players: players,
                hostId: remainingIds[0],
                submittedPlayers: Array.from(submittedPlayers)
            });
        }
    });
});

function startRound() {
    if (currentRoundIndex >= gameQueue.length) {
        io.emit('gameFinished', { scores: players });
        return;
    }
    
    // Reset round winners
    roundWinners.clear();

    const track = gameQueue[currentRoundIndex];
    io.emit('playTrack', {
        trackIndex: currentRoundIndex,
        totalTracks: gameQueue.length,
        roundCountdown: 15,
        track: { previewUrl: track.previewUrl }
    });

    let timeLeft = 15;
    roundTimer = setInterval(() => {
        timeLeft--;
        io.emit('countdown', timeLeft);
        if (timeLeft <= 0) {
            clearInterval(roundTimer);
            endRound();
        }
    }, 1000);
}

function endRound() {
    const track = gameQueue[currentRoundIndex];
    io.emit('roundEnded', {
        track: { title: track.trackName, artist: track.artistName, albumArt: track.albumArt },
        submitterName: track.submitterName,
        scores: players
    });
    currentRoundIndex++;
    setTimeout(startRound, 5000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
