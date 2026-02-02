const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from public directory
app.use(express.static('public'));

// Game state
const gameState = {
  players: {},
  host: null,
  gamePhase: 'lobby', // 'lobby', 'submission', 'playing', 'results'
  gameQueue: [],
  currentRound: null,
  scores: {},
  currentTrackIndex: 0,
  roundCountdown: 15, // Seconds to guess
  countdownInterval: null,
  submittedPlayers: new Set(),
  hasGuessedThisRound: new Set()
};

// Helper function for fuzzy matching with similarity check
function similarity(str1, str2) {
  if (!str1 || !str2) return 0;
  
  // Normalize strings
  const normalize = (str) => {
    return str.toLowerCase()
      .replace(/[^\w\s]/g, '')  // Remove special characters
      .replace(/\s+/g, ' ')     // Replace multiple spaces with single space
      .trim();
  };
  
  const s1 = normalize(str1);
  const s2 = normalize(str2);
  
  // Exact match after normalization
  if (s1 === s2) return 1;
  
  // Check if one contains the other
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  
  // Calculate similarity using simple character matching
  let matches = 0;
  const maxLength = Math.max(s1.length, s2.length);
  
  // Compare characters with some tolerance for typos
  for (let i = 0; i < Math.min(s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) {
      matches++;
    }
  }
  
  return matches / maxLength;
}

// Check if guess is correct (similarity >= 0.7 for typos)
function isGuessCorrect(guess, trackTitle, artistName) {
  const titleSimilarity = similarity(guess, trackTitle);
  const artistSimilarity = similarity(guess, artistName);
  
  // Return true if similarity is high enough
  return titleSimilarity >= 0.7 || artistSimilarity >= 0.7;
}

// Fetch songs from iTunes API
async function fetchSongs(searchTerm, limit = 10) {
  try {
    const response = await axios.get(`https://itunes.apple.com/search`, {
      params: {
        term: searchTerm,
        media: 'music',
        entity: 'song',
        limit: limit
      },
      timeout: 5000 // 5 second timeout
    });
    
    const tracks = response.data.results
      .filter(track => track.previewUrl && track.trackName && track.artistName)
      .slice(0, 8) // Limit to 8 results
      .map(track => ({
        id: track.trackId,
        title: track.trackName,
        artist: track.artistName,
        previewUrl: track.previewUrl,
        albumArt: track.artworkUrl100 || track.artworkUrl60,
        album: track.collectionName
      }));
    
    return tracks;
  } catch (error) {
    console.error('Error fetching songs:', error.message);
    return [];
  }
}

// Start a countdown for the current round
function startRoundCountdown() {
  if (gameState.countdownInterval) {
    clearInterval(gameState.countdownInterval);
  }
  
  gameState.roundCountdown = 15;
  gameState.hasGuessedThisRound.clear();
  
  io.emit('countdown', gameState.roundCountdown);
  
  gameState.countdownInterval = setInterval(() => {
    gameState.roundCountdown--;
    io.emit('countdown', gameState.roundCountdown);
    
    if (gameState.roundCountdown <= 0) {
      clearInterval(gameState.countdownInterval);
      endRound();
    }
  }, 1000);
}

// End the current round
function endRound() {
  if (gameState.currentTrackIndex >= gameState.gameQueue.length) return;
  
  const currentTrack = gameState.gameQueue[gameState.currentTrackIndex];
  
  // Give submitter bonus if at least one person guessed correctly
  const submitterId = currentTrack.submitterId;
  const submitter = gameState.players[submitterId];
  let submitterBonus = 0;
  
  if (submitter && currentTrack.wasGuessed) {
    submitterBonus = 5;
    submitter.score += submitterBonus;
    gameState.scores[submitter.name] = submitter.score;
  }
  
  // Reveal the answer to everyone
  io.emit('roundEnded', {
    track: currentTrack,
    submitterName: submitter ? submitter.name : 'Unknown',
    submitterBonus: submitterBonus,
    scores: gameState.scores,
    correctGuessers: currentTrack.correctGuessers || []
  });
  
  gameState.currentTrackIndex++;
  
  // Check if we've played all tracks
  if (gameState.currentTrackIndex >= gameState.gameQueue.length) {
    // End of game
    setTimeout(() => {
      gameState.gamePhase = 'results';
      gameState.currentRound = null;
      gameState.currentTrackIndex = 0;
      gameState.gameQueue = [];
      gameState.submittedPlayers.clear();
      io.emit('gameState', gameState);
      io.emit('gameFinished', { scores: gameState.scores });
    }, 7000);
  } else {
    // Move to next track after delay
    setTimeout(() => {
      startNextTrack();
    }, 7000);
  }
}

// Start the next track in the round
function startNextTrack() {
  if (gameState.currentTrackIndex >= gameState.gameQueue.length) {
    return;
  }
  
  const currentTrack = gameState.gameQueue[gameState.currentTrackIndex];
  
  // Reset countdown
  gameState.roundCountdown = 15;
  io.emit('countdown', gameState.roundCountdown);
  
  // Reset guess tracking
  gameState.hasGuessedThisRound.clear();
  currentTrack.wasGuessed = false;
  currentTrack.correctGuessers = [];
  
  // Tell all clients to play the track
  io.emit('playTrack', {
    trackIndex: gameState.currentTrackIndex,
    track: {
      id: currentTrack.id,
      previewUrl: currentTrack.previewUrl,
      albumArt: currentTrack.albumArt
    },
    roundCountdown: gameState.roundCountdown,
    totalTracks: gameState.gameQueue.length
  });
  
  // Start countdown
  startRoundCountdown();
}

// Shuffle array using Fisher-Yates algorithm
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // Send current game state to new connection
  socket.emit('gameState', gameState);
  
  // Player joins the game
  socket.on('joinGame', (playerName) => {
    if (gameState.players[socket.id]) {
      // Player already joined
      socket.emit('error', 'You have already joined the game');
      return;
    }
    
    // Validate player name
    if (!playerName || playerName.trim().length === 0) {
      socket.emit('error', 'Please enter a valid name');
      return;
    }
    
    if (playerName.length > 20) {
      socket.emit('error', 'Name must be 20 characters or less');
      return;
    }
    
    const trimmedName = playerName.trim();
    
    // Check for duplicate names
    const existingPlayer = Object.values(gameState.players).find(p => p.name.toLowerCase() === trimmedName.toLowerCase());
    if (existingPlayer) {
      socket.emit('error', 'Name already taken. Please choose another.');
      return;
    }
    
    // First player becomes host
    if (Object.keys(gameState.players).length === 0) {
      gameState.host = socket.id;
    }
    
    // Add player to game
    gameState.players[socket.id] = {
      id: socket.id,
      name: trimmedName,
      score: 0,
      hasSubmitted: false
    };
    
    // Initialize score
    gameState.scores[trimmedName] = 0;
    
    console.log(`${trimmedName} joined the game`);
    
    // Broadcast updated player list to everyone
    io.emit('playerJoined', {
      player: gameState.players[socket.id],
      players: Object.values(gameState.players),
      hostId: gameState.host,
      scores: gameState.scores,
      gamePhase: gameState.gamePhase,
      submittedCount: gameState.submittedPlayers.size
    });
    
    // Update game state
    io.emit('gameState', gameState);
  });
  
  // Player submits a song
  socket.on('submitSong', (song) => {
    const player = gameState.players[socket.id];
    if (!player) {
      socket.emit('error', 'You are not in the game');
      return;
    }
    
    if (player.hasSubmitted) {
      socket.emit('error', 'You have already submitted a song');
      return;
    }
    
    // Validate song data
    if (!song || !song.title || !song.artist || !song.previewUrl) {
      socket.emit('error', 'Invalid song data');
      return;
    }
    
    // Add song to game queue
    const trackWithSubmitter = {
      ...song,
      submitterId: socket.id,
      submitterName: player.name,
      wasGuessed: false,
      correctGuessers: []
    };
    
    gameState.gameQueue.push(trackWithSubmitter);
    gameState.submittedPlayers.add(socket.id);
    player.hasSubmitted = true;
    
    console.log(`${player.name} submitted: ${song.title} by ${song.artist}`);
    
    // Notify all players
    io.emit('songSubmitted', {
      playerName: player.name,
      submittedCount: gameState.submittedPlayers.size,
      totalPlayers: Object.keys(gameState.players).length
    });
    
    // Check if all players have submitted
    if (gameState.submittedPlayers.size === Object.keys(gameState.players).length && 
        Object.keys(gameState.players).length > 0) {
      gameState.gamePhase = 'ready';
      io.emit('allSongsSubmitted', {
        message: 'All players have submitted songs! Host can start the game.'
      });
    }
    
    // Update game state
    io.emit('gameState', gameState);
  });
  
  // Host starts the game
  socket.on('startGame', () => {
    if (socket.id !== gameState.host) {
      socket.emit('error', 'Only the host can start the game');
      return;
    }
    
    if (gameState.gamePhase !== 'ready' && gameState.gamePhase !== 'lobby') {
      socket.emit('error', 'Game cannot be started now');
      return;
    }
    
    if (gameState.gameQueue.length < 2) {
      socket.emit('error', 'Need at least 2 songs to start the game');
      return;
    }
    
    if (gameState.gameQueue.length !== Object.keys(gameState.players).length) {
      socket.emit('error', 'Not all players have submitted songs');
      return;
    }
    
    console.log('Host starting game with', gameState.gameQueue.length, 'songs');
    
    // Shuffle the game queue
    gameState.gameQueue = shuffleArray(gameState.gameQueue);
    
    // Set game phase
    gameState.gamePhase = 'playing';
    gameState.currentTrackIndex = 0;
    
    // Notify all players
    io.emit('gameStarted', {
      trackCount: gameState.gameQueue.length,
      host: gameState.players[gameState.host].name
    });
    
    // Start the first track after a short delay
    setTimeout(() => {
      startNextTrack();
    }, 3000);
  });
  
  // Player submits a guess
  socket.on('submitGuess', (guess) => {
    if (gameState.gamePhase !== 'playing') {
      socket.emit('error', 'No active round to guess in');
      return;
    }
    
    const player = gameState.players[socket.id];
    if (!player) {
      socket.emit('error', 'You are not in the game');
      return;
    }
    
    if (gameState.hasGuessedThisRound.has(socket.id)) {
      socket.emit('error', 'You have already guessed for this track');
      return;
    }
    
    const currentTrack = gameState.gameQueue[gameState.currentTrackIndex];
    
    // Check if player is the submitter
    if (socket.id === currentTrack.submitterId) {
      socket.emit('error', 'You cannot guess your own song!');
      return;
    }
    
    const normalizedGuess = guess.trim();
    
    if (!normalizedGuess) {
      socket.emit('error', 'Please enter a guess');
      return;
    }
    
    // Check if guess matches track title or artist
    const isCorrect = isGuessCorrect(normalizedGuess, currentTrack.title, currentTrack.artist);
    
    if (isCorrect) {
      // Award points based on how fast they guessed
      const timeLeft = gameState.roundCountdown;
      const points = 10 + Math.floor(timeLeft / 3); // Bonus for quick guesses
      
      player.score += points;
      gameState.scores[player.name] = player.score;
      
      gameState.hasGuessedThisRound.add(socket.id);
      currentTrack.wasGuessed = true;
      currentTrack.correctGuessers = currentTrack.correctGuessers || [];
      currentTrack.correctGuessers.push(player.name);
      
      // Notify the player
      socket.emit('guessResult', {
        correct: true,
        points,
        totalScore: player.score,
        timeLeft,
        songTitle: currentTrack.title,
        artist: currentTrack.artist
      });
      
      // Notify all players about the score update
      io.emit('scoreUpdate', {
        playerName: player.name,
        score: player.score,
        points,
        scores: gameState.scores
      });
      
      console.log(`${player.name} guessed correctly! +${points} points`);
    } else {
      gameState.hasGuessedThisRound.add(socket.id);
      
      // Notify the player
      socket.emit('guessResult', {
        correct: false,
        message: 'Try again next track!'
      });
      
      console.log(`${player.name} guessed incorrectly: "${guess}"`);
    }
  });
  
  // Search for songs (from client)
  socket.on('searchSongs', async (searchTerm) => {
    if (!searchTerm || searchTerm.trim().length < 2) {
      socket.emit('error', 'Please enter at least 2 characters to search');
      return;
    }
    
    try {
      const tracks = await fetchSongs(searchTerm);
      if (tracks.length === 0) {
        socket.emit('error', 'No songs found. Try a different search term.');
      } else {
        socket.emit('searchResults', tracks);
      }
    } catch (error) {
      console.error('Search error:', error.message);
      socket.emit('error', 'Failed to search for songs. Please try again.');
    }
  });
  
  // Reset the game
  socket.on('resetGame', () => {
    if (socket.id !== gameState.host) {
      return;
    }
    
    // Reset all scores
    Object.keys(gameState.players).forEach(playerId => {
      gameState.players[playerId].score = 0;
      gameState.players[playerId].hasSubmitted = false;
      gameState.scores[gameState.players[playerId].name] = 0;
    });
    
    // Reset game state
    gameState.gamePhase = 'lobby';
    gameState.gameQueue = [];
    gameState.currentRound = null;
    gameState.currentTrackIndex = 0;
    gameState.submittedPlayers.clear();
    gameState.hasGuessedThisRound.clear();
    
    if (gameState.countdownInterval) {
      clearInterval(gameState.countdownInterval);
      gameState.countdownInterval = null;
    }
    
    io.emit('gameReset', { scores: gameState.scores });
    io.emit('gameState', gameState);
  });
  
  // Play again (reset but keep players)
  socket.on('playAgain', () => {
    if (socket.id !== gameState.host) {
      return;
    }
    
    // Keep players but reset game state
    gameState.gamePhase = 'lobby';
    gameState.gameQueue = [];
    gameState.currentRound = null;
    gameState.currentTrackIndex = 0;
    gameState.submittedPlayers.clear();
    gameState.hasGuessedThisRound.clear();
    
    // Reset submission status for all players
    Object.keys(gameState.players).forEach(playerId => {
      gameState.players[playerId].hasSubmitted = false;
    });
    
    if (gameState.countdownInterval) {
      clearInterval(gameState.countdownInterval);
      gameState.countdownInterval = null;
    }
    
    io.emit('playAgainStarted');
    io.emit('gameState', gameState);
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    const playerName = gameState.players[socket.id]?.name;
    
    if (gameState.players[socket.id]) {
      // Remove player's song from queue if they submitted one
      gameState.gameQueue = gameState.gameQueue.filter(track => track.submitterId !== socket.id);
      gameState.submittedPlayers.delete(socket.id);
      
      delete gameState.players[socket.id];
      
      if (playerName) {
        delete gameState.scores[playerName];
      }
      
      // If host disconnected, assign new host
      if (socket.id === gameState.host && Object.keys(gameState.players).length > 0) {
        gameState.host = Object.keys(gameState.players)[0];
      } else if (Object.keys(gameState.players).length === 0) {
        gameState.host = null;
        // Reset everything if no players left
        gameState.gamePhase = 'lobby';
        gameState.gameQueue = [];
        gameState.submittedPlayers.clear();
      }
      
      // Broadcast updated player list
      io.emit('playerLeft', {
        playerId: socket.id,
        players: Object.values(gameState.players),
        hostId: gameState.host,
        scores: gameState.scores,
        gamePhase: gameState.gamePhase,
        submittedCount: gameState.submittedPlayers.size
      });
      
      io.emit('gameState', gameState);
    }
  });
});

// Start the server - CRITICAL FOR RENDER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
