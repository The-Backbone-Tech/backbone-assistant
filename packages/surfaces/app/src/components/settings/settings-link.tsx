import * as React from 'react';
import type { SettingsSectionId } from '@backbone-next/platform';

/**
 * Opens another Settings section from inside one, with the keyboard on `focus` (a selector) once it is
 * shown: a refusal that names a setting takes the person there in one step. Outside Settings it does nothing.
 */
export const SettingsLink = React.createContext<(section: SettingsSectionId, focus?: string) => void>(() => {});
export const useSettingsLink = () => React.useContext(SettingsLink);

/** Where a refusal for want of a model for shared work sends the person. */
export const SHARED_WORK = { section: 'model-route', focus: '[data-testid=shared-model-route] summary' } as const;
