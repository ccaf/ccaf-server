var http = require('http');
var url = require('url');
var fs = require('fs');
var path = require('path');
var os = require('os');
var dgram = require('dgram');

var ip = require('ip');
var handlebars = require('handlebars');

// Assume that config.json is located in the same directory as the server.
// Assume that the public directory is located in the same directory as the server.
var config;
var base = __dirname, configPath = 'config.json';

// Read the config file and hard fail if there's an error - can't operate with config!
try {
  config = JSON.parse(fs.readFileSync(path.resolve(base, configPath)));
} catch (e) {
  throw new Error("Failed to read configuration file. Check that the config file exists and the path is correct.");
}

// dbPath points to the location of the embedded database.
var dbPath = path.resolve(base, config.db);

// appsPath points to the folder that all apps are stored in.
var appsPath = path.resolve(base, config.apps);

// Snippets must be located in the public folder (as they originate from ccaf-web)
var snippetsPath = path.resolve(base, 'public', 'snippets');

// Load the database. If it is empty, create a blank database.
var db = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath)) : {classrooms:{}};

// Store the config on the database (overwriting any config loaded directly from the database).
// Config can be edited by the settings page, so we need to make it accessible.
db.config = config;

/* saveDB() writes the embedded database (stored in memory) to the hard disk.
 */
function saveDB() {
  // Extract configuration data from the database object and write it to its own file.
  config = db.config;
  fs.writeFile(dbPath, JSON.stringify(db), function(err) {
    if (err)
      throw new Error("Failed to write DB! Quitting to prevent use during possible further data loss.");

    fs.writeFileSync(path.resolve(base, configPath), JSON.stringify(config));
  });
}

// Save the database every minute by default. It is also written on exit, so this
// is just a contingency.
var dbInterval = setInterval(saveDB, 60 * 1000);

// Each property in db.apps refers to an app (signified by its directory name).
// E.g. the whiteboard app is stored in the whiteboard folder and thus has the
// 'whiteboard' property in db.apps. The app's key refers to an object that is
// read in from that app's package.json, and contains metadata about that app,
// e.g. the pretty name, icon, client module name.
db.apps = {};

// Populate the apps object. First, get the directory listing of the apps folder.
fs.readdirSync(appsPath)
  // Filter all listings that are not directories.
  .filter(function(maybeDir) {
    try {
      return fs.statSync(path.resolve(appsPath, maybeDir)).isDirectory();
    } catch (e) { return false; }
  })
  // Read the package.json file and assign it to the db.apps object.
  .forEach(function(dir) {
    try {
      var app = JSON.parse(fs.readFileSync(path.resolve(appsPath, dir, 'package.json')));
      db.apps[dir] = app;
    } catch (e) {}
  });

// Load partials for handlebars. Get the directory listing on the snippets folder.
fs.readdirSync(snippetsPath)
  // Grab all the snippets that are files.
  .filter(function(maybeDir) {
    try {
      return fs.statSync(path.resolve(snippetsPath, maybeDir)).isFile();
    } catch (e) { return false; }
  })
  .forEach(function(snippet) {
    try {
      // Read the snippet file.
      var content = fs.readFileSync(path.resolve(snippetsPath, snippet), 'utf8');
      // Register it as a partial referred to by its filename not including extension.
      handlebars.registerPartial(snippet.split('.')[0], '' + content + '');
    } catch (e) {}
  });

// Identify the IP address of the server for terminal stdout.
// Load all network interfaces.
var ifaces = os.networkInterfaces();
var addresses = [];

// Remove all interfaces that are not externally facing IPv4 interfaces.
Object.keys(ifaces).forEach(function (ifname) {
  ifaces[ifname].forEach(function (iface, index) {
    if ('IPv4' === iface.family && iface.internal === false)
      addresses.push(iface.address);
  });
});

// Print IP addresses to stdout.
console.log('This server\'s address(es): ' + addresses.join(', '));

// Starts the sync folder prepopulated with the embedded database. Also enables logging
// to the logs folder.
var checkerboard = new (require('checkerboard')).Server(config.ports.ws, db, {'log': true, 'logDir': path.resolve(__dirname, 'public', 'logs')});

// Debug info: print WebSocket port to terminal.
console.log('WebSocket port: ' + config.ports.ws);

// When the browser sends a message of the form {'channel': ..., 'message': ...}, checkerboard
// will emit an event of the channel name. So, on the client we can send the following
// messages and pick them up in the server without mucking around with checkerboard code.

// Clean exit - triggers a restart in nodemon and forever-monitor.
checkerboard.on('restart', function() { saveDB(); process.exit(0); });

// Exit with condition code - prevents nodemon and forever-monitor from restarting automatically.
checkerboard.on('stop', function() { saveDB(); process.exit(1); });



// The infamous super simple static server.
// At first, I used a connect static server. but what we really needed was a way
// to both serve static files and occasionally include some template variables and partials.
// Currently, the websocket port that the server is using is populated into .js files
// that are sent out, and the "snippets" feature above allows for modularity in settings
// for RequireJS.
http.createServer(function(request, response) {
  var uri = url.parse(request.url).pathname;

  // "Symlink" /logs/latest to the most recent log file (created during the current server session).
  // Will behave unpredictably when multiple servers launched out of the same root directory...
  // so don't do that...
  if (uri === "/logs/latest") {
    // The log files are labeled as the UNIX timestamp when the log file was created, with a
    // '.log extension'. So we first read all the timestamps of the log files.
    var files = fs.readdirSync(path.join(process.cwd(), "build", "public", "logs")).map(function(logFile) {
      return parseInt(path.basename(logFile, '.log'));
    });

    // The largest timestamp is the latest and thus the file that was created for the current session.
    uri = "/logs/" + Math.max(null, files) + '.log';
  }

  // Serve files from the public folder.
  var filename = path.join(process.cwd(), "build", "public", uri);

  fs.stat(filename, function(err, stat) {
    // If the stat fails, or points to something other than a directory or file, throw up a 404.
    if(err || !stat.isDirectory() && !stat.isFile()) {
      response.writeHead(404, {"Content-Type": "text/plain"});
      response.write("404 Not Found\n");
      response.end();
      return;
    }

    // If the filename refers to a directory, deliver index file if it exists.
    if (stat.isDirectory()) filename += '/index.html';

    fs.readFile(filename, "binary", function(err, file) {
      if(err) {
        response.writeHead(500, {"Content-Type": "text/plain"});
        response.write(err + "\n");
        response.end();
        return;
      }

      response.writeHead(200);

      // If the file is a .js file, use handlebars to interpolate variables.
      response.write(path.extname(filename) === '.js' ? handlebars.compile(file)(config.ports) : file, "binary");
      response.end();
    });
  });
}).listen(config.ports.http);

// Debug info to stdout.
console.log('HTTP port: ' + config.ports.http);
