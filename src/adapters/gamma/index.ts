import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { prepareGammaPage } from './capture.js';
import { detection } from './detection.js';

export const gammaAdapter: PlatformAdapter = {
	id: 'gamma',
	detection,
	discover: discoverDefault,
	liberation: {
		prepare: prepareGammaPage,
	},
};
