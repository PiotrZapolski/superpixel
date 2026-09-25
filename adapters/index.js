// Adapter registry, in display order (see lib/model.js PLATFORM_ORDER).
import * as google from './google.js';
import * as meta from './meta.js';
import * as tiktok from './tiktok.js';
import * as linkedin from './linkedin.js';
import * as bing from './bing.js';
import * as snap from './snap.js';

export const ADAPTERS = [google, meta, tiktok, linkedin, bing, snap];
