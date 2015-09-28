var app = require('http').createServer()
var io = require('socket.io')(app);
var spawn = require('child_process').spawn;
var fs = require('fs');

/* GLOBAL RULE: QUEUE[0] IS ALWAYS THE SONG PLAYING AT THE MOMENT */

// Listen to WebSocket connections on port 80
// if you do port 80, you need sudo, but vlc won't run with sudo...
app.listen(8080);

// Total current user counter
var numUsers = 0;

// Now Playing status
var playing = false;
var stopped = true;

// This holds the number of seconds elapsed since the start of the current song
var currElapsed = 0;
var intervalObj;

// Create the remote controlled VLC process
var vlc = spawn('vlc', ['-I', 'rc']);
vlc.stdin.setEncoding('utf-8');

// Pipes the command to the VLC remote control interface
function rcVLC(command) {
	var toWrite = command + "\n";
	vlcin.write(toWrite);
	vlc.stdin.write(toWrite);
}

// VLC input/output logs
var vlcin = fs.createWriteStream("/home/pi/Desktop/vlcin.txt");

// Queue log
var queueLog = fs.createWriteStream("/home/pi/Desktop/queueLog.txt");

// The current queue
var queue = [];

// Returns thumbnail url, title, duration, audio url, and sets score to 0
function getInfo(id, cb) {
	var ytdl = require('ytdl-core');
	var BASE = "http://www.youtube.com/watch?v=";
	var url = BASE + id;
	ytdl.getInfo(url,
				{"downloadURL":true},
				function (err, info) {
					// Calculate and format duration properly
					var seconds = info.length_seconds % 60;
					if (seconds < 10) 
						seconds = '0' + seconds;

					// TODO: handle err, or if info is undefined/empty to prevent some edge cases of older youtube videos that don't have audio streams
					var ret = {
						id : id,
						url : url,
						thumbnail : info.iurlhq,
						title : info.title,
						addedBy : 'aagandh2',
						length_seconds : info.length_seconds,
						duration : Math.floor(info.length_seconds / 60) + ':' + seconds,
						audioURL : '',
						nowPlaying : false,
						elapsed : 0,
						score: 0
					}

					var results = info.formats;
					// this might call the callback function more than once...
					results.forEach(function (item) {
						if ((item.type).indexOf("audio/mp4") > -1) {
							ret.audioURL = item.url;
							cb(ret);
						}
					});
	});
}

// Returns false if the song is not in the queue, or the index if it is
function songIndexInQueue(id) {
	var ret = false;

	for (var i = 0; i < queue.length; i++) {
		if (queue[i].id == id) {
			ret = i;
			break;
		}
	}

	return ret;
}

// Removes any songs from the queue that have a score of -3
// Sorts the queue based on score of the songs
function sortQueue(cb) {
	queue.forEach(function (queueItem, index) {
		if (queueItem.score < -3 ) {
			queue.splice(index,1);
		}
	});

	// Sort the queue, ignoring the now playing item
	var tempQueue = queue.slice(1);
	tempQueue.sort(function(a,b) {
		if (a.score > b.score)
			return -1;
		if (a.score < b.score)
			return 1;
		return 0;
	});

	// Delete all of it except the currently playing one, and put the sorted part back in
	queue.splice(1, queue.length-1);
	queue = queue.concat(tempQueue);

	cb();
}

// Go to next song
function nextSong(first) {
	clearInterval(intervalObj);
	currElapsed = 0;
	rcVLC('clear');

	// If the queue length is 0, do nothing
	if (queue.length == 0)
		return;

	if (!first)
		queue.shift();
	var nextSong = queue[0];

	// If the queue is now empty
	if (!nextSong) {
		playing = false;
		stopped = true;
	}

	// Add does enqueue and play
	else {
		rcVLC('add ' + nextSong.audioURL);
		playing = true;
		stopped = false;
		
		// Start incrementing elapsed every second
		intervalObj = setInterval(function () {
			currElapsed += 1;
		}, 1000);
	}

	// Send out updated queue and now playing status
	sendQueue();
	sendNowPlaying();
}

// Set repeat, loop, and random to off
rcVLC("repeat off");
rcVLC("loop off");
rcVLC("random off");

/* BROADCASTS */
function broadcast(key, value) {
	io.emit(key, value);
}

function sendNumUsers() {
	broadcast('numUsersChanged', {newNumUsers : numUsers});
}

function sendQueue() {
	io.emit('queueUpdated', {newQueue : queue});
}

function sendNowPlaying() {
	io.emit('nowPlayingChanged', {newNowPlaying : playing});
}

function sendAll() {
	sendNumUsers();
	sendQueue();
	sendNowPlaying();
}

// This checks if the current song is done playing, and if so, go to the next song
// This should occur regardless of the other setIntervals
var masterIntervalObj = setInterval(function () {
	if ( (queue.length > 0) && (playing) && (!stopped) ) {
		if (currElapsed >= queue[0].length_seconds) {
			nextSong();
		}
	}
}, 1000);

// APIs and socket interactions
io.on('connection', function (socket){

	// Up the total current user counter
	numUsers++;
	sendNumUsers();

	// Send them the queue for the first time, and the current playing status
	sendQueue();
	sendNowPlaying();
	
	// when someone disconnects, send the updated num to all the other users
	socket.on('disconnect', function () {
		numUsers--;
		sendNumUsers();
	});

	// Add a song to the queue
	// "Returns" whether the song was successfully added or not
	// This would fail if the song was too long, if it's already in the queue, or some error occurred
	socket.on('addSong', function (data, fn) {
		getInfo(data.id, function (song) {
			// Check if the song is already in the queue
			var index = songIndexInQueue(song.id);

			// If the request song is more than 10 minutes, don't allow it to be added to the queue. This is to prevent those 10 hour mixes.
			if (song.length_seconds > 600) {
				fn('Sorry, that song is too long!');
			}

			// Prevent adding the song if it's already in the queue
			else if (index !== false) {
				fn('That song is already in the queue!');
			}

			// otherwise, add the song
			else {
				queue.push(song);
				queueLog.write("Adding song: " + song.title + '\n');

				sendQueue();
				fn('Song added!');

				// If nothing is currently playing, start playing the song that was just added
				if (stopped)
					nextSong(true);
			}
		});
	});

	// Modifies the queue item's score based on what the user clicked
	// Once that's done, it sorts the queue, then sends out an updated queue
	socket.on('vote', function(data,fn) {
		var index = songIndexInQueue(data.id);
		if (index) {
			queue[index].score += data.vote;
			sortQueue(sendQueue);
			fn();
		}
	})

	/* MUSIC CONTROLS */

	socket.on('play', function (data, fn) {
		// Start incrementing elapsed every second
		intervalObj = setInterval(function () {
			currElapsed += 1;
		}, 1000);

		rcVLC('play');
		playing = true;
		sendNowPlaying();
	});

	socket.on('pause', function (data, fn) {
		clearInterval(intervalObj);

		rcVLC('pause');
		playing = false;
		sendNowPlaying();
	});

	// Clear vlc's playlist, and add from the front of our queue
	socket.on('next', function (data,fn) {
		nextSong();
	})

});

