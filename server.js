const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

// Levenshtein for typos
const levenshtein = (a, b) => {
    if(a.length == 0) return b.length; 
    if(b.length == 0) return a.length; 
    var matrix = [];
    var i;
    for(i = 0; i <= b.length; i++){ matrix[i] = [i]; }
    var j;
    for(j = 0; j <= a.length; j++){ matrix[0][j] = j; }
    for(i = 1; i <= b.length; i++){
        for(j = 1; j <= a.length; j++){
            if(b.charAt(i-1) == a.charAt(j-1)){
                matrix[i][j] = matrix[i-1][j-1];
            } else {
                matrix[i][j] = Math.min(matrix[i-1][j-1] + 1, Math.min(matrix[i][j-1] + 1, matrix[i-1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let players = {}; 
let gameQueue = []; 
let submittedPlayers = new Set(); 
let gameState = 'lobby'; 
let currentRoundIndex = 0;
let roundTimer = null;
let roundWinners = new Set(); 

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

    // --- CHAT & GUESS LOGIC ---
    socket.on('submitGuess', (guess) => {
        if (gameState !== 'playing' || !gameQueue[currentRoundIndex]) return;

        const currentTrack = gameQueue[currentRoundIndex];
        const playerName = players[socket.id].name;
        const clean = (str) => (str || "").toLowerCase().replace(/[^\w\s]/gi, '').trim();
        const userGuess = clean(guess);
        const title = clean(currentTrack.trackName);
        const artist = clean(currentTrack.artistName);

        // 1. ALREADY WON? TREAT AS CHAT
        if (roundWinners.has(socket.id)) {
            // Spoiler check: Don't let winners type the answer again!
            if (userGuess.includes(title) || title.includes(userGuess)) {
                 socket.emit('guessResult', { correct: true, points: 0, message: "Don't spoil the answer!" });
            } else {
                 // Broadcast as "Winner Chat" (Green Text)
                 io.emit('chatMessage', { name: playerName, text: guess, type: 'winner-chat' });
                 // Tell client it was sent successfully (clears box)
                 socket.emit('guessResult', { correct: true, points: 0, silent: true });
            }
            return;
        }

        // 2. PREVENT GUESSING OWN SONG
        if (socket.id === currentTrack.submitterId) {
             socket.emit('guessResult', { correct: false, message: "You can't guess your own song!" });
             return;
        }

        // 3. CHECK GUESS
        const isTitleMatch = (userGuess.length > 2 && title.includes(userGuess)) || userGuess === title;
        const isArtistMatch = (userGuess.length > 2 && artist.includes(userGuess)) || userGuess === artist;
        const titleDist = levenshtein(userGuess, title);
        const allowedTypos = Math.max(2, Math.floor(title.length * 0.4));

        if (isTitleMatch || isArtistMatch || titleDist <= allowedTypos) {
            // CORRECT!
            players[socket.id].score += 10;
            if(players[currentTrack.submitterId]) players[currentTrack.submitterId].score += 2;
            roundWinners.add(socket.id);
            
            socket.emit('guessResult', { correct: true, points: 10 });
            
            // Broadcast: "Alex guessed correctly!"
            io.emit('chatMessage', { name: playerName, text: "Guessed the answer!", type: 'correct' });
            
        } else {
            // WRONG!
            socket.emit('guessResult', { correct: false });
            
            // Broadcast wrong guess to everyone
            io.emit('chatMessage', { name: playerName, text: guess, type: 'wrong' });
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
        if (remainingIds.length > 0) io.emit('playerJoined', { players: players, hostId: remainingIds[0], submittedPlayers: Array.from(submittedPlayers) });
    });
});

function startRound() {
    if (currentRoundIndex >= gameQueue.length) {
        io.emit('gameFinished', { scores: players });
        return;
    }
    roundWinners.clear();
    const track = gameQueue[currentRoundIndex];
    io.emit('playTrack', {
        trackIndex: currentRoundIndex,
        totalTracks: gameQueue.length,
        roundCountdown: 30,
        track: { previewUrl: track.previewUrl }
    });
    let timeLeft = 30;
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
