var http = require('http');
var url = require('url');
var fs = require('fs');
var path = require('path');
var os = require('os');
var dgram = require('dgram');

var ip = require('ip');
var handlebars = require('handlebars');

// assume that config.json is located in the same directory as the server.
// assume that the public directory is located in the same directory as the server.
var config;
var base = __dirname, configPath = 'config.json';

// read config file into obj, hard fail if error
try {
  config = JSON.parse(fs.readFileSync(path.resolve(base, configPath)));
} catch (e) {
  throw new Error("Failed to read configuration file. Check that the config file exists and the path is correct.");
}

// dbPath and appsPath are configurable (in config.json)
var dbPath = path.resolve(base, config.db);
var appsPath = path.resolve(base, config.apps);

// snippets must be located in the public folder.
var snippetsPath = path.resolve(base, 'public', 'snippets');

// load database or create it if it is empty.
var db = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath)) : {classrooms:{}};
db.config = config;

function saveDB() {
  try {

    // extract configuration data from the database object and write it to its own file.
    config = db.config;
    fs.writeFile(dbPath, JSON.stringify(db), function(err) {
      if (err)
        throw new Error("Failed to write DB! Quitting to prevent use during possible further data loss.");

      fs.writeFileSync(path.resolve(base, configPath), JSON.stringify(config));
    });
  } catch (e) {
    throw new Error("Failed to write database. Check that the location is writeable.");
  }
}

// here, we save the database every minute (and also on exit)
var dbInterval = setInterval(saveDB, 60 * 1000);

// each property in apps refers to an app (signified by its directory name).
// each property refers to an object that is  just that app's package.json.
db.apps = {};

// read through all apps in the apps dir to populate the apps object.
fs.readdirSync(appsPath)
  .filter(function(maybeDir) {
    try {
      return fs.statSync(path.resolve(appsPath, maybeDir)).isDirectory();
    } catch (e) { return false; }
  })
  .forEach(function(dir) {
    try {
      var app = JSON.parse(fs.readFileSync(path.resolve(appsPath, dir, 'package.json')));
      db.apps[dir] = app;
    } catch (e) {}
  });

// similar to above, load snippets as partials for handlebars
fs.readdirSync(snippetsPath)
  .filter(function(maybeDir) {
    try {
      return fs.statSync(path.resolve(snippetsPath, maybeDir)).isFile();
    } catch (e) { return false; }
  })
  .forEach(function(snippet) {
    try {
      // read the snippet file
      var content = fs.readFileSync(path.resolve(snippetsPath, snippet), 'utf8');
      // register it as a partial referred to by its filename not including ext
      handlebars.registerPartial(snippet.split('.')[0], '' + content + '');
    } catch (e) {}
  });

// this code identifies the ip addresses of the server.

// load all network interfaces
var ifaces = os.networkInterfaces();
var addresses = [];

// filter all v6 and internal interfaces
Object.keys(ifaces).forEach(function (ifname) {
  ifaces[ifname].forEach(function (iface, index) {
    if ('IPv4' === iface.family && iface.internal === false)
      addresses.push(iface.address);
  });
});

console.log('This server\'s address(es): ' + addresses);

// starts the sync server prepopulated with the loaded database
var checkerboard = new (require('checkerboard')).Server(config.ports.ws, db, {'log': true, 'logDir': path.resolve(__dirname, 'public', 'logs')});

// when we send a message of the form {'channel': ..., 'message': ...}, checkerboard
// will emit an event of the channel name. so, on the client we can send the following
// messages and pick them up in the server without mucking around with checkerboard code.
checkerboard.on('restart', function() { saveDB(); process.exit(0); });
checkerboard.on('stop', function() { saveDB(); process.exit(1); });
console.log('Websocket port: ' + config.ports.ws);

// the infamous super simple static server.
// at first, i used a connect static server. but what we really needed was a way
// to both serve static files and occasionally include some template variables and partials.
// currently, the websocket port that the server is using is populated into js files
// that are sent out, and the "snippets" feature above allows for modularity in settings
// for requirejs.
http.createServer(function(request, response) {

  var uri = url.parse(request.url).pathname;
  var filename = path.join(process.cwd(), "build", "public", uri);

  fs.stat(filename, function(err, stat) {
    if (err) return;
    if(!stat.isDirectory() && !stat.isFile()) {
      response.writeHead(404, {"Content-Type": "text/plain"});
      response.write("404 Not Found\n");
      response.end();
      return;
    }

    if (stat.isDirectory()) filename += '/index.html';

    fs.readFile(filename, "binary", function(err, file) {
      if(err) {
        response.writeHead(500, {"Content-Type": "text/plain"});
        response.write(err + "\n");
        response.end();
        return;
      }

      response.writeHead(200);

      response.write(path.extname(filename) === '.js' ? handlebars.compile(file)(config.ports) : file, "binary");
      response.end();
    });
  });
}).listen(config.ports.http);

console.log('HTTP port: ' + config.ports.http);
