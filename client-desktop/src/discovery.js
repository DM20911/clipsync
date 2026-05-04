// mDNS discovery — find the hub on the LAN.
import { Bonjour } from 'bonjour-service';

export function findHub({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const browser = bonjour.find({ type: 'clipsync', protocol: 'tcp' });
    const stop = () => { try { browser.stop(); bonjour.destroy(); } catch {} };

    const onUp = (svc) => {
      const ip = (svc.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
        || svc.host;
      if (!ip) return;
      const out = {
        name: svc.name,
        host: ip,
        port: svc.port,
        url: `wss://${ip}:${svc.port}`,
        txt: svc.txt || {},
      };
      stop();
      resolve(out);
    };

    browser.on('up', onUp);
    setTimeout(() => { stop(); resolve(null); }, timeoutMs);
  });
}
