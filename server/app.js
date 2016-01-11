// peertable (peer-to-peer + turntable.fm)
// peer-to-peer party-playlisting

// std lib
var fs   = require('fs'),
    http = require('http'),
    path = require('path');
// npm lib
var _              = require('lodash'),
    bodyparser     = require('body-parser'),
    commander      = require('commander'),
    express        = require('express'),
    expressWinston = require('express-winston'),
    handlebars     = require('handlebars'),
    peer           = require('peer'),
    socketio       = require('socket.io'),
    stringEscape   = require('js-string-escape'),
    winston        = require('winston');
// local
var defaultConfig = require('./default-config.json'),
    utils         = require('./utils');
// shared
var shared = require('../shared'),
    MODE   = shared.MODE;

// Parse command line arguments
// the parity of commander.js coercion functions matters. If a coercion function
// has parity != 1, the default value is passed in as the second parameter.
function unaryResolvePath(value) { return path.resolve(value); }
commander
    .option('--initdb', 'Initialize the database')
    .option('-h, --hostname [hostname]', 'Restrict to a hostname')
    .option('-p, --port [portnum]',
        'Set the port number [default '+defaultConfig.port+']'
    )
    .option(
        '-c, --config [path]',
        'Set the config location [default /etc/peertable.conf.json]',
        unaryResolvePath, '/etc/peertable.conf.json'
    )
    .parse(process.argv);
var cmdOpts = _.pick(commander, ['hostname', 'port']);

// Load config, then apply defaults, then override with command line options
var config = utils.loadConfig(commander.config);
_.defaultsDeep(config, defaultConfig);
global.config = _.assign(config, cmdOpts, function(value, other) {
  // this check is needed because commander.hasOwnProperty returns true
  // for unset options
  return _.isUndefined(other) ? value : other;
});
// automatic config and globals
global.development = process.env.NODE_ENV !== 'production';
global.config.host = (global.config.hostname||'')+':'+global.config.port;

// Set up logging
winston.level = global.config.logLevel;
winston.debug('logging debug messages');
winston.info('loading application logic')

// Connect to database. Loading this module sets up the db connection.
var models = require('./models');
if (commander.initdb) {
  models.initialize();
}

// Set up express.
var app = express();
var server = http.createServer(app);
// no entity-tags on routes
app.set('etag', false);
// middleware
app.use(bodyparser.json());
app.use(bodyparser.urlencoded({ extended:false }));
// static folders and files express.static has etags by default
app.use('/assets', express.static(path.resolve(__dirname, '../assets')));

// Request logging.
if (global.config.logRequests) {
  winston.debug("logging requests");
  app.use(expressWinston.logger({
    transports: [
      new winston.transports.Console({
        colorize: true,
      })
    ],
    meta: false,
    msg: 'HTTP {{req.method}} {{req.url}}',
  }));
}

// Set up socket.io
var io = socketio(server);

// Set up signaling server.
// force PeerServer's debug option
_.apply(global.config.peerServerOpts, {
  debug: global.development,
});
app.use('/peerjs',
  peer.ExpressPeerServer(server, global.config.peerServerOpts)
);

// Set up the routes.
app.use('/api', require('./api'));
// only one template for now, so let's have some fun with closures
var render = (function() {
  var template = null;
  var templatepath = path.join(__dirname, 'views/index.hbs');
  function reload() {
    var templateString = fs.readFileSync(templatepath).toString();
    template = handlebars.compile(templateString);
  }
  return function(vars) {
    if (!template || global.development) reload();
    return template({
      vars: JSON.stringify(vars)
    });
  }
})();
// TODO handle favicon
app.get('/favicon.ico', function(req, res) {
  res.sendStatus(404);
});
// load the create-room interface
app.get('/', function(req, res) {
  res.send(render({
    mode: MODE.CREATE,
  }));
});
// url for a specific room
app.get('/:token', function(req, res, next) {
  // try to fetch the room
  models.Room.where({pathtoken: req.params.token})
    .fetch()
    .then(function(room) {
      if (room) {
        // load the regular interface
        res.send(render({
          mode: MODE.JOIN,
          room: room.serializePublic()
        }));
      } else {
        // load the create-room interface
        res.send(render({
          mode: MODE.CREATE,
        }));
      }
    }).catch(function(err) {
      next(err);
    });
});

// app.use(expressWinston.errorLogger({
//   transports: [
//     new winston.transports.Console({
//       json: true,
//       colorize: true,
//     })
//   ]
// }));

// you got this!
server.listen(global.config.port, global.config.hostname, function(err) {
  if (err) throw err;
  winston.info('listening on port', global.config.port);
});
