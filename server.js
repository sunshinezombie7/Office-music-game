const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');
const levenshtein = require('levenshtein'); // Ensure this is in package.json

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// SERVE STATIC FILES
app.use(express.static(path.join(__dirname, 'public')));

// DATA STORAGE
let players = {}; // { socketId: { id, name, score, hasSubmitted } }
let gameQueue = []; // Array of song objects to play
let submittedPlayers = new Set(); // Track who has submitted
let gameState = 'lobby'; // 'lobby', 'submission', 'playing', 'results'
let currentRoundIndex = 0;
let roundTimer = null;

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. JOIN GAME
    socket.on('joinGame', (name) => {
        players[socket.id] = {
            id: socket.id,
            name: name || `Player ${socket.id.substr(0,4)}`,
            score: 0,
            hasSubmitted: false
        };
        
        // Send everyone the new player list
        io.emit('playerJoined', {
            players: players,
            hostId: Object.keys(players)[0], // First player is host
            submittedPlayers: Array.from(submittedPlayers)
        });
    });

    // 2. SEARCH ITUNES (Fixes "Undefined" bug)
    socket.on('searchSongs', async (query) => {
        try {
            const response = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=5`);
            
            // MAP data to exactly what HTML expects
            const results = response.data.results.map(track => ({
                trackName: track.trackName,
                artistName: track.artistName,
                previewUrl: track.previewUrl,
                albumArt: track.artworkUrl100
            }));
            
            socket.emit('searchResults', results);
        } catch (error) {
            console.error("Search failed", error);
        }
    });

    // 3. SUBMIT SONG (Fixes "Stuck" bug)
    socket.on('submitSong', (song) => {
        if (!players[socket.id]) return;

        // Tag the song with who picked it
        song.submitterId = socket.id;
        song.submitterName = players[socket.id].name;
        
        // Add to queue
        gameQueue.push(song);
        submittedPlayers.add(socket.id);
        players[socket.id].hasSubmitted = true;

        // CHECK IF READY TO START
        const totalPlayers = Object.keys(players).length;
        const totalSubmitted = submittedPlayers.size;
        const isReady = totalSubmitted === totalPlayers && totalPlayers > 0;

        io.emit('songSubmitted', {
            players: players,
            submittedPlayers: Array.from(submittedPlayers), // Send as array for count
            isReady: isReady
        });
    });

    // 4. START GAME
    socket.on('startGame', () => {
        gameState = 'playing';
        currentRoundIndex = 0;
        
        // Shuffle the queue
        gameQueue = gameQueue.sort(() => Math.random() - 0.5);
        
        io.emit('gameStarted', { trackCount: gameQueue.length });
        
        // Start first round after delay
        setTimeout(startRound, 3000);
    });

    // 5. GUESS LOGIC
    socket.on('submitGuess', (guess) => {
        if (gameState !== 'playing' || !gameQueue[currentRoundIndex]) return;

        const currentTrack = gameQueue[currentRoundIndex];
        
        // Prevent guessing your own song
        if (socket.id === currentTrack.submitterId) {
             socket.emit('guessResult', { correct: false, message: "You can't guess your own song!" });
             return;
        }

        // FUZZY MATCHING (Levenshtein)
        const cleanGuess = guess.toLowerCase().trim();
        const titleDist = new levenshtein(cleanGuess, currentTrack.trackName.toLowerCase()).distance;
        const artistDist = new levenshtein(cleanGuess, currentTrack.artistName.toLowerCase()).distance;
        
        // Allow typo tolerance (3 characters or less wrong)
        const isCorrect = titleDist <= 3 || artistDist <= 3 || currentTrack.trackName.toLowerCase().includes(cleanGuess);

        if (isCorrect) {
            players[socket.id].score += 10;
            // Bonus for the person who picked the song (their song was recognizable!)
            if(players[currentTrack.submitterId]) {
                players[currentTrack.submitterId].score += 2;
            }
            
            socket.emit('guessResult', { correct: true, points: 10 });
        } else {
            socket.emit('guessResult', { correct: false });
        }
    });
    
    // 6. PLAY AGAIN
    socket.on('playAgain', () => {
        gameQueue = [];
        submittedPlayers.clear();
        Object.values(players).forEach(p => p.hasSubmitted = false);
        gameState = 'lobby';
        io.emit('playAgainStarted');
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        delete players[socket.id];
        submittedPlayers.delete(socket.id);
        
        // If host leaves, assign new host
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

// GAME LOOP HELPERS
function startRound() {
    if (currentRoundIndex >= gameQueue.length) {
        // Game Over
        io.emit('gameFinished', { scores: players });
        return;
    }

    const track = gameQueue[currentRoundIndex];

    // Tell clients to play (hide details)
    io.emit('playTrack', {
        trackIndex: currentRoundIndex,
        totalTracks: gameQueue.length,
        roundCountdown: 15,
        track: { previewUrl: track.previewUrl } // Only send audio URL
    });

    // Start Countdown
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
    
    // Reveal Answer
    io.emit('roundEnded', {
        track: {
            title: track.trackName,
            artist: track.artistName,
            albumArt: track.albumArt
        },
        submitterName: track.submitterName,
        scores: players
    });

    currentRoundIndex++;
    
    // Wait 5 seconds before next round
    setTimeout(startRound, 5000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
