import type * as React from 'react';
import { cn } from '../../lib/utils';

/** One setting: its title and one line of explanation on the left, its control on the right. */
export function SettingsRow({ title, about, children, className }: { title: React.ReactNode; about?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2.5 border-b border-border py-4 sm:flex-row sm:items-center sm:gap-8', className)}>
      <div className="min-w-0 flex-1 sm:min-w-48">
        <div className="text-ui font-medium leading-5">{title}</div>
        {about && <p className="mt-0.5 max-w-lg text-xs leading-5 text-muted">{about}</p>}
      </div>
      {children && <div className="flex min-w-0 flex-wrap items-center gap-2 sm:max-w-[58%] sm:justify-end">{children}</div>}
    </div>
  );
}
