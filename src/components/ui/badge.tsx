// shadcn/ui Badge pattern adapted for this app's new-york component style.
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-none', {
  variants: {
    variant: {
      default: 'border-teal-200 bg-teal-50 text-teal-800',
      neutral: 'border-slate-200 bg-slate-100 text-slate-600',
      dark: 'border-white/15 bg-white/10 text-white/75',
      warning: 'border-amber-200 bg-amber-50 text-amber-800',
      purple: 'border-violet-200 bg-violet-50 text-violet-800',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}
function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
