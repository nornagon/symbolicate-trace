# symbolicate-trace

This tool symbolicates `cpu_profiler` traces produced by Electron's
[contentTracing](https://electronjs.org/docs/api/content-tracing) system.

The `disabled-by-default-cpu_profiler` tracing category records a sample of the
_native_ stack trace every 50 ms. This can be helpful in tracking down
performance issues in native code.

To record such stack samples, include the `disabled-by-default-cpu_profiler`
category in the content tracing configuration:

```js
contentTracing.startRecording({
  included_categories: [
    'disabled-by-default-cpu_profiler',
    // ...
  ]
})
```

## Usage

```
$ npx symbolicate-trace path/to/recording.trace
Reading trace...
Parsing trace...
Symbolicating...
Writing symbolicated trace to 'path/to/recording.trace.symbolicated'...
$
```
