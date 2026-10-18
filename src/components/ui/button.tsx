// shadcn/ui Button pattern adapted for this app's new-york component style.
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'bg-ink text-white shadow-sm hover:bg-ink/90',
        primary: 'bg-teal-700 text-white shadow-sm hover:bg-teal-800',
        secondary: 'border border-line bg-surface text-ink hover:bg-panel',
        outline: 'border border-white/15 bg-white/5 text-white hover:bg-white/10',
        ghost: 'text-muted hover:bg-panel hover:text-ink',
        quiet: 'text-white/65 hover:bg-white/10 hover:text-white',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        icon: 'h-9 w-9',
        lg: 'h-11 rounded-xl px-5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
