// Every demo string and number shown in the video. The brand is fictional and the
// IDs are placeholders in the formats Superpixel reports (see detect/signatures.js).

import type {LogoId} from './components/logos';

export const DOMAIN = 'acme-outdoor.com';
export const SITE_NAME = 'Acme Outdoor';

export type DemoTag = {name: string; logo: LogoId; id: string; category: string};

/** In the order the tag rows pop into the panel. */
export const TAGS: DemoTag[] = [
	{name: 'Google Tag Manager', logo: 'gtm', id: 'GTM-XXXXXXX', category: 'Tag managers'},
	{name: 'Google Analytics 4', logo: 'ga4', id: 'G-XXXXXXXXXX', category: 'Analytics'},
	{name: 'Google Ads', logo: 'google', id: 'AW-XXXXXXXXXX', category: 'Ads'},
	{name: 'Meta Pixel', logo: 'meta', id: '1234567890123456', category: 'Ads'},
	{name: 'TikTok Pixel', logo: 'tiktok', id: 'CXXXXXXXXXXXXXXXXXXX', category: 'Ads'},
];

/** Short labels for the badges on the page, with their position in the page area (0..1). */
export const PAGE_BADGES: {label: string; logo: LogoId; x: number; y: number}[] = [
	{label: 'Google Tag Manager', logo: 'gtm', x: 0.5, y: 0.035},
	{label: 'GA4', logo: 'ga4', x: 0.33, y: 0.29},
	{label: 'Google Ads', logo: 'google', x: 0.31, y: 0.565},
	{label: 'Meta Pixel', logo: 'meta', x: 0.66, y: 0.19},
	{label: 'TikTok Pixel', logo: 'tiktok', x: 0.6, y: 0.7},
];

export type DemoLibrary = {
	id: LogoId;
	name: string;
	coverage: string;
	ads: number;
	confirmed: number;
};

/** The six public ad libraries Superpixel queries (adapters/*.js), coverage as on the landing. */
export const LIBRARIES: DemoLibrary[] = [
	{id: 'google', name: 'Google Ads', coverage: 'Global, incl. YouTube', ads: 14, confirmed: 9},
	{id: 'meta', name: 'Meta', coverage: 'Global, active ads', ads: 23, confirmed: 17},
	{id: 'tiktok', name: 'TikTok', coverage: 'EU/EEA, UK, Switzerland', ads: 6, confirmed: 4},
	{id: 'linkedin', name: 'LinkedIn', coverage: 'Global, last 12 months', ads: 3, confirmed: 3},
	{id: 'bing', name: 'Microsoft (Bing)', coverage: 'EU/EEA', ads: 5, confirmed: 2},
	{id: 'snap', name: 'Snapchat', coverage: 'EU', ads: 2, confirmed: 0},
];

export const TOTAL_ADS = LIBRARIES.reduce((n, l) => n + l.ads, 0);
export const TOTAL_CONFIRMED = LIBRARIES.reduce((n, l) => n + l.confirmed, 0);

export type Match = 'confirmed' | 'advertiser' | 'keyword' | 'name';

/** Ad rows for the labels scene, one per match label (labels as on the landing). */
export const AD_ROWS: {logo: LogoId; title: string; meta: string; match: Match; hint: string; thumb: [string, string]}[] = [
	{
		logo: 'google',
		title: 'Autumn sale: 30% off all tents',
		meta: 'Landing page: acme-outdoor.com/sale',
		match: 'confirmed',
		hint: 'Links to the domain',
		thumb: ['#1f4d3a', '#e8743b'],
	},
	{
		logo: 'meta',
		title: 'New trail packs are here',
		meta: 'Landing page: shop.acmegear.co',
		match: 'advertiser',
		hint: 'Same advertiser',
		thumb: ['#2f6b52', '#f2c14e'],
	},
	{
		logo: 'tiktok',
		title: 'Acme Outdoor vs. the rest: boot test',
		meta: 'Landing page: trailreviews.example',
		match: 'keyword',
		hint: 'Mentions the brand',
		thumb: ['#3b3355', '#f0a6ca'],
	},
	{
		logo: 'snap',
		title: 'Weekend camping checklist',
		meta: 'Advertiser: Acme Outdoor',
		match: 'name',
		hint: 'Name match only',
		thumb: ['#5b4a2f', '#9ad1d4'],
	},
];

export const EXPORT_FILE = 'superpixel-acme-outdoor.com-20261009.json';

export const SITE_URL = 'superpixel.run';
