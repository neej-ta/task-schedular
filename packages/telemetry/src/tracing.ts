// OpenTelemetry tracing (spec §16) — gateway → queue → worker → target DB.
//
// FAIL-SOFT: tracing is enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set,
// and the SDK is loaded via dynamic import inside try/catch so that any OTel
// dependency/runtime issue can NEVER prevent a service from starting. Service
// name comes from OTEL_SERVICE_NAME (read automatically by the SDK).

let sdk: { shutdown: () => Promise<void> } | null = null;

export async function startTracing(serviceName: string): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  if (!process.env.OTEL_SERVICE_NAME) process.env.OTEL_SERVICE_NAME = serviceName;
  try {
    // String-typed specifiers so TS treats these as optional (any) — the
    // packages are not bundled by default (see package.json note).
    const sdkPkg: string = '@opentelemetry/sdk-node';
    const autoPkg: string = '@opentelemetry/auto-instrumentations-node';
    const expPkg: string = '@opentelemetry/exporter-trace-otlp-http';
    const { NodeSDK } = await import(sdkPkg);
    const { getNodeAutoInstrumentations } = await import(autoPkg);
    const { OTLPTraceExporter } = await import(expPkg);
    const instance = new NodeSDK({
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });
    instance.start();
    sdk = instance as unknown as { shutdown: () => Promise<void> };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ svc: serviceName, msg: 'otel tracing started', endpoint }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`otel tracing disabled: ${(err as Error).message}`);
  }
}

export async function stopTracing(): Promise<void> {
  if (sdk) await sdk.shutdown().catch(() => {});
  sdk = null;
}
