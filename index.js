var fs = require('fs');
var path = require('path');
var os = require('os');
var dgram = require('dgram');
  
var ip = require('ip');
var connect = require('connect');

var config;
var base = __dirname, configPath = 'config.json';

try {
  config = JSON.parse(fs.readFileSync(path.resolve(base, configPath)));
} catch (e) {
  throw new Error("Failed to read configuration file. Check that the config file exists and the path is correct.");
};

var dbPath = path.resolve(base, config.db);
var appsPath = path.resolve(base, config.apps);

var db = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath)) : {};

function saveDB() {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(db));
  } catch (e) {
    throw new Error("Failed to write database. Check that the location is writeable.");
  }
}

var dbInterval = setInterval(saveDB, 60 * 1000);

db.apps = {};

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
  
var ifaces = os.networkInterfaces();
var addresses = [];

Object.keys(ifaces).forEach(function (ifname) {
  ifaces[ifname].forEach(function (iface, index) {
    if ('IPv4' === iface.family && iface.internal === false)
      addresses.push(iface.address);
  });
});

console.log('This server\'s address(es): ' + addresses);

var dgramClient = dgram.createSocket({'type': 'udp4', reuseAddr: true});
dgramClient.bind({'address': 'localhost', 'port': config.ports.udp}, function() {
  dgramClient.setBroadcast(true);
  dgramClient.setMulticastTTL(128);
  console.log('UDP port: ' + config.ports.udp);

  addresses.forEach(function(address) {
    console.log('Broadcasting to ' + ip.subnet(address, config.subnet).broadcastAddress);
    setInterval(function() {
      var message = new Buffer(JSON.stringify({'ports': config.ports}));
      dgramClient.send(message, 0, message.length, config.ports.udp, ip.subnet(address, config.subnet).broadcastAddress);
    }, 150);
  });
});

var checkerboard = new (require('checkerboard')).Server(config.ports.ws, db);
console.log('Websocket port: ' + config.ports.ws);

var app = connect();

app.use(function(req, res, next){ 
  res.setHeader('Last-Modified', (new Date()).toUTCString());
  next(); 
}).use('/', connect.static(__dirname + '/public/client')).use(connect.static(__dirname + '/public')).listen(config.ports.http);

console.log('HTTP port: ' + config.ports.http);