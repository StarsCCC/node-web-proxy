const {ArgumentParser} = require('argparse');
const path = require('path');
const http = require("http");
const debug = require('debug');
const _ = require('underscore');

const {buildMatcher, findProxyForURL, PROXY} = require('./lib/pac');
const {getHostPortFromString, jsonLoad} = require('./lib/utils');
const httpsProxy = require('./lib/https-sys-proxy');
const httpsDirect = require('./lib/https-direct');
const httpUserRequest = require('./lib/http-both');

if (_.isEmpty(process.env.DEBUG)) {
  process.env.DEBUG = 'proxy-init,error,*-error';
}
process.on('unhandledRejection', (reason, p) => {
  gLogger.error('Unhandled Rejection at:', p, 'reason:', reason);
});
const gLogger = {
  init: debug('proxy-init'),
  fsock: debug('frontend-socket'),
  guest: debug('guest'),
  error: debug('error')
};
const parser = new ArgumentParser({
  version: '0.0.1',
  addHelp: true,
  description: 'A HTTP(S) Forward Proxy built upon nodejs'
});
parser.addArgument([ '-p', '--port' ], {
  action: 'store',
  defaultValue: process.env.PORT || 5555,
  help: 'The port on which the HTTP(S) Proxy to listens. (Default: 5555)',
  type: 'int'
});
parser.addArgument([ '-spp', '--system-proxy-port' ], {
  action: 'store',
  defaultValue: process.env.SYSTEM_PROXY_PORT || 1080,
  dest: 'sysProxyPort',
  help: 'The port number of the system proxy underlying the HTTP(S) Forward Proxy. (Default: 1080)',
  type: 'int'
});
parser.addArgument([ '-gwl', '--guest-whitelist' ], {
  action: 'store',
  defaultValue: process.env.GUEST_WHITELIST || path.resolve(__dirname, './config/guest-whitelist.json'),
  dest: 'gwlFilePath',
  help: 'Only the clients enjoy the paid forward proxy whose ips are in the whitelist file.',
  type: 'string'
});
parser.addArgument([ '-pr', '--pac-rules' ], {
  action: 'store',
  defaultValue: process.env.PAC_RULES || path.resolve(__dirname, './config/pac-rules.json'),
  dest: 'prFilePath',
  help: 'Only the web sites the paid forward proxy whose ips are in the whitelist file.',
  type: 'string'
});
const cliArgs = parser.parseArgs();
const SYSTEM_PROXY = {
  ipaddress: "localhost", // Random public proxy
  port: cliArgs.sysProxyPort,
  type: 5, // type is REQUIRED. Valid types: [4, 5]  (note 4 also works for 4a)
  command: 'connect'  // This defaults to connect, so it's optional if you're not using BIND or Associate.
};
gLogger.init(`forward proxy listening on port ${cliArgs.port}`);
gLogger.init(`system proxy is expected on port ${cliArgs.sysProxyPort}`);
gLogger.init(`guest-whitelist file is ${cliArgs.gwlFilePath}`);
gLogger.init(`pac-rules file is ${cliArgs.prFilePath}`);
const gwlPromise = jsonLoad(cliArgs.gwlFilePath);
const matcherPromise = buildMatcher(cliArgs.prFilePath);
// start HTTP server with custom request handler callback function
const server = http.createServer(async (userRequest, userResponse) => { // handle a HTTP proxy request
  const {url, client:{remoteAddress}} = userRequest;
  const hostport = getHostPortFromString(url, 443);
  const [matcher, guestWhiteList] = await Promise.all([matcherPromise, gwlPromise]);
  let sysProxy;
  if (matcher.findProxyForURL(url, hostport[0]) === PROXY &&
      guestWhiteList.includes(remoteAddress)) { // paid
    sysProxy = SYSTEM_PROXY;
  } // free
  httpUserRequest(gLogger, sysProxy, userRequest, userResponse);
}).listen(cliArgs.port);
// add handler for HTTPS (which issues a CONNECT to the proxy)
server.addListener("connect", async (request, socketRequest, bodyhead) => { // HTTPS connect listener
  const {url, client:{remoteAddress}} = request;
  const hostport = getHostPortFromString(url, 443);
  const [matcher, guestWhiteList] = await Promise.all([matcherPromise, gwlPromise]);
  if (matcher.findProxyForURL(`https://${url}`, hostport[0]) === PROXY &&
      guestWhiteList.includes(remoteAddress)) { // paid
    httpsProxy(gLogger, SYSTEM_PROXY, request, socketRequest, bodyhead)
      .catch(err => gLogger.error('https proxy -', err));
  } else { // free
    httpsDirect(gLogger, request, socketRequest, bodyhead);
  }
});
