// Setup imports
try {
  const Module = require('module');

  try {
    // resolve puppeteer from the CWD instead of where this script is located
    var puppeteer = require(require.resolve('puppeteer', { paths: Module._nodeModulePaths(process.cwd()) }));
  } catch (puppeteerError) {
    try {
      // try resolve `puppeteer-core` library instead
      var puppeteer = require(require.resolve('puppeteer-core', { paths: Module._nodeModulePaths(process.cwd()) }));
    } catch (coreError) {
      // raise the original puppeteer load issue so we don't send people don't the wrong rabbit hole by default.
      throw puppeteerError;
    }
  }
} catch (e) {
  process.stdout.write(JSON.stringify(['err', e.toString()]));
  process.stdout.write("\n");
  process.exit(1);
}

process.stdout.write("[\"ok\"]\n");

const fs = require('fs');
const os = require('os');
const path = require('path');

function GroverError(name, errors) {
  this.name = name;
  this.message = errors.map(e => e.message).join("\n");
  this.errors = errors;
}
GroverError.prototype = Error.prototype;

// Browser connection management for batch mode
let cachedBrowser = null;
let cachedBrowserEndpoint = null;
let cachedTmpDir = null;

// Streaming session management
let streamingSession = null;

// Retry configuration (can be overridden via options)
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_DELAY = 100;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectOrLaunchBrowser(options, forceNew = false) {
  const browserWsEndpoint = options.browserWsEndpoint;

  // If we have a cached browser that matches, reuse it
  if (!forceNew && cachedBrowser && cachedBrowser.connected) {
    if (browserWsEndpoint && cachedBrowserEndpoint === browserWsEndpoint) {
      return { browser: cachedBrowser, wsConnection: true, tmpDir: null, reused: true };
    }
    if (!browserWsEndpoint && !cachedBrowserEndpoint) {
      return { browser: cachedBrowser, wsConnection: false, tmpDir: cachedTmpDir, reused: true };
    }
  }

  // Close any existing cached browser if it doesn't match
  if (cachedBrowser) {
    try {
      if (cachedBrowserEndpoint) {
        await cachedBrowser.disconnect();
      } else {
        await cachedBrowser.close();
      }
    } catch { }
    cachedBrowser = null;
    cachedBrowserEndpoint = null;
    if (cachedTmpDir) {
      try { fs.rmSync(cachedTmpDir, { recursive: true }); } catch { }
      cachedTmpDir = null;
    }
  }

  let browser, wsConnection = false, tmpDir = null;

  if (typeof browserWsEndpoint === "string") {
    const connectParams = {
      browserWSEndpoint: browserWsEndpoint,
    };
    wsConnection = true;

    try {
      browser = await puppeteer.connect(connectParams);
    } catch {
      function WsConnectFailedError() {
        this.name = "WsConnectFailedError";
        this.message = `Failed to connect to browser WS endpoint: ${browserWsEndpoint}`;
      }
      WsConnectFailedError.prototype = Error.prototype;
      throw new WsConnectFailedError();
    }
    cachedBrowserEndpoint = browserWsEndpoint;
  } else {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grover-'));

    const debug = options.debug;
    const launchParams = {
      args: process.env.GROVER_NO_SANDBOX === 'true' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
      userDataDir: tmpDir
    };

    if (typeof debug === 'object' && !!debug) {
      if (debug.headless !== undefined) { launchParams.headless = debug.headless; }
      if (debug.devtools !== undefined) { launchParams.devtools = debug.devtools; }
    }

    // Configure additional launch arguments
    const args = options.launchArgs;
    if (Array.isArray(args)) {
      launchParams.args = launchParams.args.concat(args);
    }

    // Set browser type if given
    const browserType = options.browser;
    if (browserType) {
      launchParams.browser = browserType;
    }

    // Set executable path if given
    const executablePath = options.executablePath;
    if (executablePath) {
      launchParams.executablePath = executablePath;
    }

    // Launch the browser
    browser = await puppeteer.launch(launchParams);
    cachedTmpDir = tmpDir;
    cachedBrowserEndpoint = null;
  }

  cachedBrowser = browser;
  return { browser, wsConnection, tmpDir, reused: false };
}

async function closeBrowser(browser, wsConnection, tmpDir, keepAlive = false) {
  if (keepAlive) {
    // In batch mode, don't close the browser
    return;
  }

  if (browser) {
    if (wsConnection) {
      await browser.disconnect();
    } else {
      await browser.close();
    }
  }

  // Clear cached browser reference
  if (browser === cachedBrowser) {
    cachedBrowser = null;
    cachedBrowserEndpoint = null;
  }

  try {
    if (tmpDir && !keepAlive) {
      fs.rmSync(tmpDir, { recursive: true });
      if (tmpDir === cachedTmpDir) {
        cachedTmpDir = null;
      }
    }
  } catch { }
}

async function shutdownBrowser() {
  if (cachedBrowser) {
    try {
      if (cachedBrowserEndpoint) {
        await cachedBrowser.disconnect();
      } else {
        await cachedBrowser.close();
      }
    } catch { }
    cachedBrowser = null;
    cachedBrowserEndpoint = null;
  }

  if (cachedTmpDir) {
    try { fs.rmSync(cachedTmpDir, { recursive: true }); } catch { }
    cachedTmpDir = null;
  }
}

const _processPage = (async (convertAction, uriOrHtml, options, keepAlive = false) => {
  let browser, page, tmpDir, wsConnection = false, reused = false;
  const requestErrors = [], pageErrors = [];

  const captureRequestError = (request) => {
    const requestError = { url: request.url() };

    if (request.failure()) {
      requestError.reason = request.failure().errorText;
      requestError.message = requestError.reason + " at " + requestError.url;
    } else if (request.response() && request.response().status()) {
      requestError.status = request.response().status();
      requestError.message = requestError.status + " " + requestError.url;
    } else {
      requestError.message = "UnknownError " + requestError.url;
    }

    requestErrors.push(requestError);
  };

  try {
    // Configure puppeteer debugging options
    const debug = options.debug; delete options.debug;
    const browserWsEndpoint = options.browserWsEndpoint; delete options.browserWsEndpoint;

    // Extract retry options
    const retryCount = options.retryCount !== undefined ? options.retryCount : DEFAULT_RETRY_COUNT;
    delete options.retryCount;
    const retryDelay = options.retryDelay !== undefined ? options.retryDelay : DEFAULT_RETRY_DELAY;
    delete options.retryDelay;

    // Connect or launch browser with retry logic
    let lastError;
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        const browserOpts = { browserWsEndpoint, debug, launchArgs: options.launchArgs, browser: options.browser, executablePath: options.executablePath };
        const result = await connectOrLaunchBrowser(browserOpts, attempt > 0);
        browser = result.browser;
        wsConnection = result.wsConnection;
        tmpDir = result.tmpDir;
        reused = result.reused;
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (attempt < retryCount) {
          await sleep(retryDelay * Math.pow(2, attempt)); // Exponential backoff
        }
      }
    }
    if (lastError) throw lastError;

    // Clean up options that were used for browser launch
    delete options.launchArgs;
    delete options.browser;
    delete options.executablePath;

    page = await browser.newPage();

    // Basic auth
    const username = options.username; delete options.username
    const password = options.password; delete options.password
    if (username !== undefined && password !== undefined) {
      await page.authenticate({ username, password });
    }

    // Setting cookies
    const cookies = options.cookies; delete options.cookies
    if (Array.isArray(cookies)) {
      if (typeof browser.setCookie === 'function') {
        await browser.setCookie(...cookies);
      } else if (typeof page.setCookie === 'function') {
        await page.setCookie(...cookies);
      }
    }

    // Set caching flag (if provided)
    const cache = options.cache; delete options.cache;
    if (cache !== undefined) {
      await page.setCacheEnabled(cache);
    }

    // Setup timeout option (if provided)
    if (options.timeout === null) delete options.timeout;
    let requestOptions = {};
    let requestTimeout = options.requestTimeout; delete options.requestTimeout;
    if (requestTimeout === undefined) requestTimeout = options.timeout;
    if (requestTimeout !== undefined) {
      requestOptions.timeout = requestTimeout;
    }

    // Setup user agent (if provided)
    const userAgent = options.userAgent; delete options.userAgent;
    if (userAgent !== undefined) {
      await page.setUserAgent(userAgent);
    }

    // Setup viewport options (if provided)
    const viewport = options.viewport; delete options.viewport;
    if (viewport !== undefined) {
      await page.setViewport(viewport);
    }

    // If specified, emulate the media type
    const emulateMedia = options.emulateMedia; delete options.emulateMedia;
    if (emulateMedia !== undefined) {
      if (typeof page.emulateMediaType === 'function') {
        await page.emulateMediaType(emulateMedia);
      } else {
        await page.emulateMedia(emulateMedia);
      }
    }

    // Emulate the media features, if specified
    const mediaFeatures = options.mediaFeatures; delete options.mediaFeatures;
    if (Array.isArray(mediaFeatures)) {
      await page.emulateMediaFeatures(mediaFeatures);
    }

    // Emulate timezone (if provided)
    const timezone = options.timezone; delete options.timezone;
    if (timezone !== undefined) {
      await page.emulateTimezone(timezone);
    }

    // Bypass CSP (content security policy), if provided
    const bypassCSP = options.bypassCSP; delete options.bypassCSP;
    if (bypassCSP !== undefined) {
      await page.setBypassCSP(bypassCSP);
    }

    // Add extra HTTP headers (if provided)
    const extraHTTPHeaders = options.extraHTTPHeaders; delete options.extraHTTPHeaders;
    if (extraHTTPHeaders !== undefined) {
      await page.setExtraHTTPHeaders(extraHTTPHeaders);
    }

    // Set geolocation (if provided)
    const geolocation = options.geolocation; delete options.geolocation;
    if (geolocation !== undefined) {
      await page.setGeolocation(geolocation);
    }

    // If specified, add script to evaluate before the page loads
    const evaluateOnNewDocument = options.evaluateOnNewDocument; delete options.evaluateOnNewDocument;
    if (evaluateOnNewDocument !== undefined) {
      await page.evaluateOnNewDocument(evaluateOnNewDocument);
    }

    // If specified (and enabled) and the browser is Chrome v132+ (supports the permission) allow local network access
    const allowLocalNetworkAccess = options.allowLocalNetworkAccess; delete options.allowLocalNetworkAccess;
    const browserVersion = await browser.version();
    if (allowLocalNetworkAccess === true && Number.parseInt(browserVersion.match('^Chrome/(\\d+)')?.[1]) >= 132) {
      const cdp = await page.createCDPSession();
      await cdp.send('Browser.setPermission', { permission: { name: 'local-network-access' }, setting: 'granted' });
    }

    const raiseOnRequestFailure = options.raiseOnRequestFailure; delete options.raiseOnRequestFailure;
    if (raiseOnRequestFailure) {
      page.on('requestfinished', (request) => {
        if (request.response() &&
            !(request.response().ok() || request.response().status() === 304) &&
            !request.redirectChain().length > 0) {
          captureRequestError(request);
        }
      });
      page.on('requestfailed', (request) => {
        captureRequestError(request);
      });
    }

    const raiseOnJSError = options.raiseOnJSError; delete options.raiseOnJSError;
    if (raiseOnJSError) {
      page.on('pageerror', (error) => {
        pageErrors.push({
          message: error.toString().replace(new RegExp('^' + error.name + ': '), ''),
          type: error.name || 'Error'
        });
      });
    }

    const waitUntil = options.waitUntil; delete options.waitUntil;
    const allowFileUri = options.allowFileUri; delete options.allowFileUri;
    const uriRegex = allowFileUri ? /^(https?|file):\/\//i : /^https?:\/\//i;
    if (uriOrHtml.match(uriRegex)) {
      // Request is for a URL, so request it
      requestOptions.waitUntil = waitUntil || 'networkidle2';
      await page.goto(uriOrHtml, requestOptions);
    } else {
      // Request is some HTML content. Use request interception to assign the body
      requestOptions.waitUntil = waitUntil || 'networkidle0';
      await page.setRequestInterception(true);
      let htmlIntercepted = false;
      page.on('request', request => {
        // We only want to intercept the first request - ie our HTML
        if (htmlIntercepted)
          request.continue();
        else {
          htmlIntercepted = true
          request.respond({ body: uriOrHtml === '' ? ' ' : uriOrHtml });
        }
      });
      const displayUrl = options.displayUrl; delete options.displayUrl;
      await page.goto(displayUrl || 'http://example.com', requestOptions);
    }

    // add styles (if provided)
    const styleTagOptions = options.styleTagOptions; delete options.styleTagOptions;
    if (Array.isArray(styleTagOptions)) {
      for (const styleTagOption of styleTagOptions) {
        await page.addStyleTag(styleTagOption);
      }
    }

    // add scripts (if provided)
    const scriptTagOptions = options.scriptTagOptions; delete options.scriptTagOptions;
    if (Array.isArray(scriptTagOptions)) {
      for (const scriptTagOption of scriptTagOptions) {
        await page.addScriptTag(scriptTagOption);
      }
    }

    // If specified, evaluate script on the page
    const executeScript = options.executeScript; delete options.executeScript;
    if (executeScript !== undefined) {
      await page.evaluate(executeScript);
    }

    // If specified, wait for selector
    const waitForSelector = options.waitForSelector; delete options.waitForSelector;
    const waitForSelectorOptions = options.waitForSelectorOptions; delete options.waitForSelectorOptions;
    if (waitForSelector !== undefined) {
      await page.waitForSelector(waitForSelector, waitForSelectorOptions);
    }

    // If specified, wait for function
    const waitForFunction = options.waitForFunction; delete options.waitForFunction;
    const waitForFunctionOptions = options.waitForFunctionOptions; delete options.waitForFunctionOptions;
    if (waitForFunction !== undefined) {
      await page.waitForFunction(waitForFunction, waitForFunctionOptions);
    }

    // If specified, wait for timeout
    const waitForTimeout = options.waitForTimeout; delete options.waitForTimeout;
    if (waitForTimeout !== undefined) {
      await page.waitForTimeout(waitForTimeout);
    }

    // Emulate vision deficiency (if provided)
    const visionDeficiency = options.visionDeficiency; delete options.visionDeficiency;
    if (visionDeficiency !== undefined) {
      await page.emulateVisionDeficiency(visionDeficiency);
    }

    // If specified, focus on the specified selector
    const focusSelector = options.focus; delete options.focus;
    if (focusSelector !== undefined) {
      await page.focus(focusSelector);
    }

    // If specified, hover on the specified selector
    const hoverSelector = options.hover; delete options.hover;
    if (hoverSelector !== undefined) {
      await page.hover(hoverSelector);
    }

    if (requestErrors.length > 0) {
      throw new GroverError("RequestFailedError", requestErrors);
    }

    if (pageErrors.length > 0) {
      throw new GroverError("PageRenderError", pageErrors);
    }

    // Setup conversion timeout
    if (options.convertTimeout !== undefined) {
      options.timeout = options.convertTimeout;
      delete options.convertTimeout;
    }

    // If we're running puppeteer in headless mode, return the converted PDF
    if (debug === undefined || (typeof debug === 'object' && (debug.headless === undefined || debug.headless))) {
      const buffer = Buffer.from(await page[convertAction](options));
      return {
        type: 'base64',
        data: buffer.toString('base64')
      };
    }
  } finally {
    if (page) {
      try { await page.close(); } catch { }
    }
    await closeBrowser(browser, wsConnection, tmpDir, keepAlive);
  }
});

function _handleError(error) {
  if (error instanceof GroverError) {
    process.stdout.write(JSON.stringify(['err', error.message, error.name, error.errors]));
  } else if (error instanceof Error) {
    process.stdout.write(
      JSON.stringify(['err', error.toString().replace(new RegExp('^' + error.name + ': '), ''), error.name])
    );
  } else {
    process.stdout.write(JSON.stringify(['err', error.toString()]));
  }
  process.stdout.write("\n");
}

// Command handlers for batch mode
async function handleCommand(command, args) {
  switch (command) {
    case 'convert':
      // Standard conversion: [method, url_or_html, options]
      return await _processPage(args[0], args[1], args[2], false);

    case 'batch':
      // Batch conversion (keep browser alive): [method, url_or_html, options]
      return await _processPage(args[0], args[1], args[2], true);

    case 'streamStart':
      // Initialize streaming session: [options]
      if (streamingSession !== null) {
        throw new Error('Streaming session already active. Call streamFinish first.');
      }
      streamingSession = {
        buffer: '',
        options: args[0] || {}
      };
      return true;

    case 'streamAppend':
      // Append to streaming buffer: [chunk]
      if (streamingSession === null) {
        throw new Error('streamAppend called without streamStart');
      }
      streamingSession.buffer += args[0];
      return true;

    case 'streamFinish': {
      // Finish streaming and convert: []
      if (streamingSession === null) {
        throw new Error('streamFinish called without streamStart');
      }
      // Capture and clear state before async operation
      const { buffer, options } = streamingSession;
      streamingSession = null;
      return await _processPage('pdf', buffer, options, true);
    }

    case 'shutdown':
      // Graceful shutdown
      await shutdownBrowser();
      return true;

    case 'ping':
      // Health check
      return { alive: true, browserConnected: cachedBrowser && cachedBrowser.connected };

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// Interface for communicating between Ruby processor and Node processor
require('readline').createInterface({
  input: process.stdin,
  terminal: false,
}).on('line', function(line) {
  try {
    const parsed = JSON.parse(line);

    // Check if this is the new command format: ["command", ...args]
    // or the legacy format: [method, url_or_html, options]
    const isNewFormat = typeof parsed[0] === 'string' &&
                        ['convert', 'batch', 'streamStart', 'streamAppend', 'streamFinish', 'shutdown', 'ping'].includes(parsed[0]);

    if (isNewFormat) {
      const [command, ...args] = parsed;
      Promise.resolve(handleCommand(command, args))
        .then(function (result) {
          process.stdout.write(JSON.stringify(['ok', result]));
          process.stdout.write("\n");
        })
        .catch(_handleError);
    } else {
      // Legacy format for backward compatibility
      Promise.resolve(_processPage.apply(null, parsed))
        .then(function (result) {
          process.stdout.write(JSON.stringify(['ok', result]));
          process.stdout.write("\n");
        })
        .catch(_handleError);
    }
  } catch(error) {
    _handleError(error);
  }
});
