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
let gamePhase = 'lobby'; 
let currentRoundIndex = 0;
let roundTimer = null;
let roundStartTime = 0; 
let roundWinners = new Set();
let isRoundActive = false; 

// --- HINT SYSTEM VARIABLES ---
let currentDisplayTitle = ""; 
let currentHiddenIndices = []; 

// --- TRACK DJ POINTS FOR THIS ROUND ---
let currentDjPoints = 0; 

// FIX 2: IMPROVED CLEAN FUNCTION (Removes (Remastered), - Deluxe, etc.)
const clean = (str) => {
    return (str || "")
        .toLowerCase()
        .replace(/\(.*\)|\[.*\]/g, "") // Removes anything in () or []
        .replace(/-.*/g, "")          // Removes anything after a dash
        .replace(/[^\w\s]/gi, '')     // Removes special chars
        .trim();
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('joinGame', (data) => {
        // FIX 1: LOBBY LOCK - Prevent joining if selection or game started
        if (gamePhase !== 'lobby') {
            socket.emit('loginError', "Game already in progress! Wait for the next lobby.");
            return;
        }

        let nameInput = data.name || "";
        let colorInput = data.color || "#3498db";
        const cleanName = nameInput.trim();
        const isTaken = Object.values(players).some(p => p.name.toLowerCase() === cleanName.toLowerCase());
        
        if (isTaken) {
            socket.emit('loginError', "Name already taken! Choose another.");
            return;
        }
        
        players[socket.id] = {
            id: socket.id,
            name: cleanName || `Player ${socket.id.substr(0,4)}`,
            color: colorInput,
            score: 0,
            hasSubmitted: false
        };

        // FIX 1.5: GAME STATE SYNC - Tells the player exactly what phase the game is in
        socket.emit('gameStateSync', {
            phase: gamePhase,
            currentRound: currentRoundIndex,
            totalTracks: gameQueue.length
        });
        
        io.emit('playerJoined', {
            players: players,
            hostId: Object.keys(players)[0],
            submittedPlayers: Array.from(submittedPlayers),
            phase: gamePhase
        });
    });

    socket.on('openSongSelection', () => {
        const hostId = Object.keys(players)[0];
        if (socket.id !== hostId) return;
        gamePhase = 'selection';
        io.emit('selectionStarted');
    });

    // FIX 3: HOST SKIP ROUND
    socket.on('skipRound', () => {
        const hostId = Object.keys(players)[0];
        if (socket.id === hostId && isRoundActive) {
            clearInterval(roundTimer);
            io.emit('chatMessage', { name: "SYSTEM", text: "Host skipped the round.", type: 'wrong', color: '#ff3333' });
            endRound();
        }
    });

    socket.on('kickPlayer', (targetId) => {
        const hostId = Object.keys(players)[0];
        if (socket.id !== hostId) return;
        if (players[targetId]) {
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) targetSocket.disconnect(true);
            delete players[targetId];
            submittedPlayers.delete(targetId);
            io.emit('playerJoined', {
                players: players,
                hostId: Object.keys(players)[0],
                submittedPlayers: Array.from(submittedPlayers),
                phase: gamePhase
            });
        }
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
            hostId: Object.keys(players)[0], 
            submittedPlayers: Array.from(submittedPlayers),
            isReady: totalSubmitted === totalPlayers && totalPlayers > 0
        });
    });

    socket.on('startGame', () => {
        gamePhase = 'playing';
        currentRoundIndex = 0;
        gameQueue = gameQueue.sort(() => Math.random() - 0.5);
        io.emit('gameStarted', { trackCount: gameQueue.length });
        setTimeout(startRound, 3000);
    });

    socket.on('submitGuess', (guess) => {
        if (gamePhase !== 'playing') return;

        const player = players[socket.id];
        const playerName = player.name;
        const playerColor = player.color;
        
        if (!isRoundActive) {
            io.emit('chatMessage', { name: playerName, text: guess, type: 'chat', color: playerColor });
            socket.emit('guessResult', { correct: true, points: 0, silent: true });
            return;
        }

        const currentTrack = gameQueue[currentRoundIndex];
        const userGuess = clean(guess);
        const title = clean(currentTrack.trackName);
        const artist = clean(currentTrack.artistName);

        if (roundWinners.has(socket.id)) {
            if (userGuess.includes(title) || title.includes(userGuess)) {
                 socket.emit('guessResult', { correct: true, points: 0, message: "Don't spoil it!" });
            } else {
                 io.emit('chatMessage', { name: playerName, text: guess, type: 'winner-chat', color: playerColor });
                 socket.emit('guessResult', { correct: true, points: 0, silent: true });
            }
            return;
        }

        if (socket.id === currentTrack.submitterId) {
             if (userGuess.includes(title) || title.includes(userGuess)) {
                 socket.emit('guessResult', { correct: false, message: "Don't spoil your own song!" });
             } else {
                 io.emit('chatMessage', { name: playerName, text: guess, type: 'dj-chat', color: playerColor });
                 socket.emit('guessResult', { correct: true, points: 0, silent: true });
             }
             return;
        }

        const isArtistMatch = (userGuess.length > 2 && artist.includes(userGuess)) || userGuess === artist;
        if (isArtistMatch) {
            socket.emit('guessResult', { correct: false, message: "That's the artist! Guess the title!" });
            io.emit('chatMessage', { name: playerName, text: guess, type: 'wrong', color: playerColor });
            return; 
        }

        // --- WIN CONDITION: TITLE ONLY ---
        const isSignificantPart = (userGuess.length >= title.length * 0.5) && title.includes(userGuess);
        const isExactMatch = userGuess === title;
        const titleDist = levenshtein(userGuess, title);
        const allowedTypos = Math.max(1, Math.floor(title.length * 0.2)); 

        if (isSignificantPart || isExactMatch || titleDist <= allowedTypos) {
            const now = Date.now();
            const elapsedSeconds = (now - roundStartTime) / 1000;
            let pointsEarned = Math.max(5, Math.ceil(30 - elapsedSeconds));
            
            players[socket.id].score += pointsEarned;
            
            if(players[currentTrack.submitterId]) {
                const bonus = 3;
                players[currentTrack.submitterId].score += bonus;
                currentDjPoints += bonus;
            }

            roundWinners.add(socket.id);
            socket.emit('guessResult', { correct: true, points: pointsEarned });
            io.emit('chatMessage', { name: playerName, text: `Guessed correctly! (+${pointsEarned})`, type: 'correct', color: playerColor });

            const totalPossibleGuessers = Object.keys(players).length - 1;
            if (roundWinners.size >= totalPossibleGuessers && totalPossibleGuessers > 0) {
                setTimeout(() => { clearInterval(roundTimer); endRound(); }, 1000);
            }
        } else {
            socket.emit('guessResult', { correct: false });
            io.emit('chatMessage', { name: playerName, text: guess, type: 'wrong', color: playerColor });
        }
    });
    
    socket.on('playAgain', () => {
        gameQueue = [];
        submittedPlayers.clear();
        roundWinners.clear();
        Object.values(players).forEach(p => { p.hasSubmitted = false; p.score = 0; });
        gamePhase = 'lobby'; 
        isRoundActive = false;
        io.emit('playAgainStarted');
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        submittedPlayers.delete(socket.id);
        roundWinners.delete(socket.id);
        const remainingIds = Object.keys(players);
        if (remainingIds.length > 0) io.emit('playerJoined', { 
            players: players, 
            hostId: remainingIds[0], 
            submittedPlayers: Array.from(submittedPlayers),
            phase: gamePhase
        });
    });
});

function startRound() {
    if (currentRoundIndex >= gameQueue.length) {
        io.emit('gameFinished', { scores: players });
        isRoundActive = false;
        return;
    }
    roundWinners.clear();
    const track = gameQueue[currentRoundIndex];
    roundStartTime = Date.now();
    isRoundActive = true; 
    currentDjPoints = 0;
    
    currentDisplayTitle = track.trackName.toUpperCase();
    currentHiddenIndices = [];
    
    const initialMask = currentDisplayTitle.split('').map((char, index) => {
        if (/[A-Z0-9]/.test(char)) {
            currentHiddenIndices.push(index);
            return '_';
        }
        return char;
    }).join('');
    
    currentHiddenIndices = currentHiddenIndices.sort(() => Math.random() - 0.5);

    io.emit('playTrack', {
        trackIndex: currentRoundIndex,
        totalTracks: gameQueue.length,
        roundCountdown: 30,
        track: { previewUrl: track.previewUrl },
        submitterName: track.submitterName,
        hintMask: initialMask
    });
    
    let timeLeft = 30;
    roundTimer = setInterval(() => {
        timeLeft--;
        io.emit('countdown', timeLeft);
        
        if (timeLeft <= 20 && timeLeft % 5 === 0 && currentHiddenIndices.length > 0) {
            const indexToReveal = currentHiddenIndices.pop(); 
            const charToReveal = currentDisplayTitle[indexToReveal];
            io.emit('revealHint', { index: indexToReveal, char: charToReveal });
        }

        if (timeLeft <= 0) {
            clearInterval(roundTimer);
            endRound();
        }
    }, 1000);
}

function endRound() {
    isRoundActive = false; 
    const track = gameQueue[currentRoundIndex];
    
    if(currentDjPoints > 0) {
        const djName = track.submitterName;
        io.emit('chatMessage', { 
            name: "SYSTEM", 
            text: `DJ ${djName} earned +${currentDjPoints} PTS this round! 💰`, 
            type: 'winner-chat', 
            color: '#ffffff' 
        });
    }

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
