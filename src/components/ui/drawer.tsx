import {Drawer as BaseDrawer} from '@base-ui/react/drawer';
import type {ReactNode} from 'react';

type DrawerPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
};

export function DrawerPanel({open, onOpenChange, title, description, children, className}: DrawerPanelProps) {
  return (
    <BaseDrawer.Root open={open} onOpenChange={onOpenChange}>
      <BaseDrawer.Portal>
        <BaseDrawer.Backdrop className="drawer-backdrop" />
        <BaseDrawer.Viewport className="drawer-viewport">
          <BaseDrawer.Popup className={`drawer-popup ${className ?? ''}`}>
            <BaseDrawer.Content className="drawer-content">
              <header className="drawer-heading">
                <BaseDrawer.Title className="drawer-title">{title}</BaseDrawer.Title>
                {description ? <BaseDrawer.Description className="drawer-description">{description}</BaseDrawer.Description> : null}
              </header>
              {children}
            </BaseDrawer.Content>
            <BaseDrawer.Close className="drawer-close" aria-label="Закрыть окно">×</BaseDrawer.Close>
          </BaseDrawer.Popup>
        </BaseDrawer.Viewport>
      </BaseDrawer.Portal>
    </BaseDrawer.Root>
  );
}
