#!/usr/bin/env node
const fs = require('fs')
const { rm, rename } = require('fs/promises')
const path = require('path')
const stream = require('stream')
const { promisify } = require('util')
const breakpad = require('parse-breakpad')
const got = require('got')
const mkdirp = require('mkdirp')

const symbolFiles = new Map

const defaultCacheDirectory = () => path.resolve(__dirname, 'cache', 'breakpad_symbols')

async function fetchSymbol(directory, baseUrl, pdb, id, symbolFileName) {
  const url = `${baseUrl}/${encodeURIComponent(pdb)}/${id}/${encodeURIComponent(symbolFileName)}`
  const symbolPath = path.join(directory, pdb, id, symbolFileName)
  const pipeline = promisify(stream.pipeline)

  try {
    // Download to a temporary directory first.
    const str = got.stream(url, {
      decompress: true,
      followRedirect: true,
    })
    const tmpDir = path.join(directory, 'in_progress')
    const tmpFileName = `${pdb}_${id}_${symbolFileName}.download`
    await mkdirp(tmpDir)
    await pipeline(str, fs.createWriteStream(path.join(tmpDir, tmpFileName)))

    // If we were successful, move the symbol into place.
    // This is so that a partially-successful download doesn't leave a corrupt
    // symbol file in place to be read on subsequent runs.
    await mkdirp(path.dirname(symbolPath))
    await rename(path.join(tmpDir, tmpFileName), symbolPath)
  } catch (err) {
    if (err.message.startsWith('Response code 404')) {
      return false
    } else {
      throw err
    }
  }

  return true
}

const SYMBOL_BASE_URLS = [
  'https://symbols.mozilla.org/try',
  'https://symbols.electronjs.org',
]

async function getSymbolFile(moduleId, moduleName, opts) {
  const { cacheDirectory, forceRefetch } = opts
  const pdb = moduleName.replace(/^\//, '')
  const symbolFileName = pdb.replace(/(\.pdb)?$/, '.sym')
  const symbolPath = path.join(cacheDirectory, pdb, moduleId, symbolFileName)
  if (fs.existsSync(symbolPath) && !forceRefetch) {
    try {
      return breakpad.parse(fs.createReadStream(symbolPath))
    } catch (e) {
      // If the parsing failed, remove the symbol path and try redownloading.
      console.warn(`Failed to parse ${symbolPath}: ${e.stack}`)
      console.warn('Flushing cache and attempting redownload.')
      await rm(path.dirname(symbolPath), { recursive: true, force: true })
    }
  }
  if (!fs.existsSync(symbolPath) && (!fs.existsSync(path.dirname(symbolPath)) || forceRefetch)) {
    for (const baseUrl of SYMBOL_BASE_URLS) {
      try {
        if (await fetchSymbol(cacheDirectory, baseUrl, pdb, moduleId, symbolFileName))
          return breakpad.parse(fs.createReadStream(symbolPath))
      } catch (e) {
        // This is a presumably transient error while fetching (or
        // parsing—maybe the symbols were corrupted?), so remove the symbol
        // directory to trigger a refetch next time we try.
        await rm(path.dirname(symbolPath), { recursive: true, force: true })
        throw e
      }
    }
  }
}

async function symbolicateFrame(frame, opts) {
  // ref: https://source.chromium.org/chromium/chromium/src/+/main:third_party/perfetto/src/trace_processor/export_json.cc;l=1413-1420;drc=4e07ae3dd7097bf13b7fff93547d140ac2c8ca83
  const m = /^0x([0-9a-f]+) - (.+) \[([0-9A-F]+)\]$/.exec(frame)
  if (m) {
    const [, offsetHex, moduleName, moduleId] = m
    const offset = parseInt(offsetHex, 16)
    if (!symbolFiles.has(moduleId)) {
      symbolFiles.set(moduleId, getSymbolFile(moduleId, moduleName, opts))
    }
    const symbols = await symbolFiles.get(moduleId)
    if (symbols) {
      const line = symbols.lookup(offset)
      if (line) {
        return `${frame} ${line.func.name}` + (line.file ? ` (${line.file}:${line.line})` : '')
      }
    }
  }
  return frame
}

async function symbolicateFrames(framesStr, opts) {
  const frameLines = framesStr.split(/\n/)
  return (await Promise.all(frameLines.map(l => symbolicateFrame(l, opts)))).join('\n')
}

async function maybeSymbolicate(event, opts) {
  if (event.cat === 'disabled-by-default-cpu_profiler' && event.args && event.args.frames) {
    return {
      ...event,
      args: {
        ...event.args,
        frames: await symbolicateFrames(event.args.frames, opts)
      }
    }
  } else {
    return event
  }
}

async function symbolicate(trace, options = {}) {
  const opts = {
    cacheDirectory: defaultCacheDirectory(),
    forceRefetch: false,
    ...options
  }
  return {...trace, traceEvents: await Promise.all(trace.traceEvents.map(e => maybeSymbolicate(e, opts)))}
}

async function cli(argv) {
  if (!argv[2] || !fs.statSync(argv[2]).isFile()) {
    console.error(`Usage: symbolicate-trace <path/to/recording.trace>`)
    console.error(`Output will be written to path/to/recording.trace.symbolicated.`)
    process.exit(1)
  }
  const filename = argv[2]
  console.error('Reading trace...')
  const traceJson = fs.readFileSync(filename)
  console.error('Parsing trace...')
  const trace = JSON.parse(traceJson)
  console.error('Symbolicating...')

  const symbolicated = await symbolicate(trace)

  const outFile = filename + '.symbolicated'
  console.error(`Writing symbolicated trace to '${outFile}'...`)
  fs.writeFileSync(outFile, JSON.stringify(symbolicated))
}

module.exports = { symbolicate, cli }

if (require.main === module) {
  cli(process.argv)
}
