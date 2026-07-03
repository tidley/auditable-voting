import {
  Button as AriaButton,
  FieldError as AriaFieldError,
  Input as AriaInput,
  Label as AriaLabel,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuTrigger as AriaMenuTrigger,
  Popover as AriaPopover,
  Switch as AriaSwitch,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  type ButtonProps as AriaButtonProps,
  type InputProps as AriaInputProps,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  type SwitchProps as AriaSwitchProps,
  type TextAreaProps as AriaTextAreaProps,
  type TextFieldProps as AriaTextFieldProps,
} from "react-aria-components";
import {
  flexRender,
  type Table as TanStackTable,
} from "@tanstack/react-table";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpFromLine,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clipboard,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileDown,
  Info,
  KeyRound,
  ListPlus,
  LoaderCircle,
  LogIn,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  Minus,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  SquarePen,
  Trash2,
  Upload,
  UserRound,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes } from "react";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

const iconMap = {
  action: ArrowRight,
  add: Plus,
  back: ArrowLeft,
  book: BookOpen,
  cancel: X,
  check: Check,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  clipboard: Clipboard,
  copy: Copy,
  download: Download,
  edit: SquarePen,
  export: FileDown,
  external: ExternalLink,
  info: Info,
  invite: UserPlus,
  key: KeyRound,
  login: LogIn,
  logout: LogOut,
  mail: Mail,
  menu: Menu,
  message: MessageSquare,
  minus: Minus,
  qr: QrCode,
  refresh: RefreshCw,
  reset: RotateCcw,
  save: Save,
  search: Search,
  send: Send,
  settings: Settings,
  share: Share2,
  shield: ShieldCheck,
  spinner: LoaderCircle,
  upload: Upload,
  user: UserRound,
  users: Users,
  view: Eye,
  uploadLine: ArrowUpFromLine,
  downloadLine: ArrowDownToLine,
  delete: Trash2,
  listAdd: ListPlus,
  none: Circle,
} satisfies Record<string, LucideIcon>;

export type UiIconName = keyof typeof iconMap;

export function UiIcon({ name, className }: { name: UiIconName; className?: string }) {
  const Icon = iconMap[name];
  return <Icon className={cx("av-ui-icon", className)} aria-hidden='true' focusable='false' />;
}

type UiButtonProps = Omit<AriaButtonProps, "className"> & {
  className?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  icon?: UiIconName | false;
  iconOnly?: boolean;
  iconPosition?: "start" | "end";
};

export function UiButton({
  className,
  variant = "secondary",
  disabled,
  isDisabled,
  icon = "action",
  iconOnly = false,
  iconPosition = "start",
  children,
  onPress,
  ...props
}: UiButtonProps) {
  const iconElement = icon ? <UiIcon name={icon} /> : null;
  const labelElement = children ? <span className='av-ui-button-label'>{children}</span> : null;
  const baseClassName = cx(
    "av-ui-button",
    `av-ui-button-${variant}`,
    (isDisabled ?? disabled) && "is-disabled",
    iconOnly && "av-ui-button-icon-only",
    iconPosition === "end" && "av-ui-button-icon-end",
    icon === "delete" && "av-ui-button-delete",
    className,
  );

  if (props.role === "tab" || props.role === "menuitem") {
    const nativeProps = props as ButtonHTMLAttributes<HTMLButtonElement>;
    return (
      <button
        {...nativeProps}
        type={nativeProps.type ?? "button"}
        disabled={isDisabled ?? disabled}
        className={baseClassName}
        onClick={(event) => {
          nativeProps.onClick?.(event);
          if (!event.defaultPrevented && !(isDisabled ?? disabled)) {
            onPress?.(event as never);
          }
        }}
      >
        {iconPosition === "end" ? labelElement : iconElement}
        {iconPosition === "end" ? iconElement : labelElement}
      </button>
    );
  }

  return (
    <AriaButton
      {...props}
      onPress={onPress}
      isDisabled={isDisabled ?? disabled}
      className={({ isPressed, isFocusVisible, isDisabled: renderedDisabled }) => cx(
        "av-ui-button",
        `av-ui-button-${variant}`,
        isPressed && "is-pressed",
        isFocusVisible && "is-focus-visible",
        renderedDisabled && "is-disabled",
        iconOnly && "av-ui-button-icon-only",
        iconPosition === "end" && "av-ui-button-icon-end",
        icon === "delete" && "av-ui-button-delete",
        className,
      )}
    >
      {iconPosition === "end" ? labelElement : iconElement}
      {iconPosition === "end" ? iconElement : labelElement}
    </AriaButton>
  );
}

type UiSwitchProps = Omit<AriaSwitchProps, "className" | "children"> & {
  className?: string;
  label?: string;
};

export function UiSwitch({ className, label, ...props }: UiSwitchProps) {
  return (
    <AriaSwitch
      {...props}
      className={({ isSelected, isFocusVisible, isDisabled }) => cx(
        "av-ui-switch",
        isSelected && "is-selected",
        isFocusVisible && "is-focus-visible",
        isDisabled && "is-disabled",
        className,
      )}
    >
      <span className='av-ui-switch-track' aria-hidden='true'>
        <span className='av-ui-switch-knob' />
      </span>
      {label ? <span className='av-ui-switch-label'>{label}</span> : null}
    </AriaSwitch>
  );
}

type UiFieldShellProps = {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode;
  fieldClassName?: string;
};

type UiTextFieldProps = Omit<AriaTextFieldProps, "className" | "children"> & UiFieldShellProps & {
  inputClassName?: string;
  inputRef?: Ref<HTMLInputElement>;
  inputProps?: Omit<AriaInputProps, "className">;
};

export function UiTextField({
  label,
  description,
  errorMessage,
  fieldClassName,
  inputClassName,
  inputRef,
  inputProps,
  isDisabled,
  isInvalid,
  ...props
}: UiTextFieldProps) {
  const ariaLabel = props["aria-label"] ?? inputProps?.["aria-label"];
  return (
    <AriaTextField
      {...props}
      aria-label={ariaLabel}
      isDisabled={isDisabled}
      isInvalid={isInvalid}
      className={cx("av-ui-field", fieldClassName)}
    >
      {label ? <AriaLabel className='av-ui-label'>{label}</AriaLabel> : null}
      <AriaInput {...inputProps} ref={inputRef} className={cx("av-ui-input", inputClassName)} />
      {description ? <span className='av-ui-description'>{description}</span> : null}
      {errorMessage ? <AriaFieldError className='av-ui-error'>{errorMessage}</AriaFieldError> : null}
    </AriaTextField>
  );
}

type UiTextAreaProps = Omit<AriaTextFieldProps, "className" | "children"> & UiFieldShellProps & {
  textAreaClassName?: string;
  textAreaProps?: Omit<AriaTextAreaProps, "className">;
};

export function UiTextArea({
  label,
  description,
  errorMessage,
  fieldClassName,
  textAreaClassName,
  textAreaProps,
  isDisabled,
  isInvalid,
  ...props
}: UiTextAreaProps) {
  const ariaLabel = props["aria-label"] ?? textAreaProps?.["aria-label"];
  return (
    <AriaTextField
      {...props}
      aria-label={ariaLabel}
      isDisabled={isDisabled}
      isInvalid={isInvalid}
      className={cx("av-ui-field", fieldClassName)}
    >
      {label ? <AriaLabel className='av-ui-label'>{label}</AriaLabel> : null}
      <AriaTextArea {...textAreaProps} className={cx("av-ui-input av-ui-textarea", textAreaClassName)} />
      {description ? <span className='av-ui-description'>{description}</span> : null}
      {errorMessage ? <AriaFieldError className='av-ui-error'>{errorMessage}</AriaFieldError> : null}
    </AriaTextField>
  );
}

type UiSelectProps = SelectHTMLAttributes<HTMLSelectElement> & UiFieldShellProps & {
  selectClassName?: string;
};

export function UiSelect({
  label,
  description,
  errorMessage,
  fieldClassName,
  selectClassName,
  children,
  id,
  ...props
}: UiSelectProps) {
  return (
    <label className={cx("av-ui-field", fieldClassName)} htmlFor={id}>
      {label ? <span className='av-ui-label'>{label}</span> : null}
      <span className='av-ui-select-wrap'>
        <select {...props} id={id} className={cx("av-ui-input av-ui-select", selectClassName)}>
          {children}
        </select>
        <UiIcon name='chevronDown' className='av-ui-select-icon' />
      </span>
      {description ? <span className='av-ui-description'>{description}</span> : null}
      {errorMessage ? <span className='av-ui-error'>{errorMessage}</span> : null}
    </label>
  );
}

type UiMenuProps<T extends object> = Omit<AriaMenuProps<T>, "className"> & {
  trigger: ReactNode;
  className?: string;
  popoverClassName?: string;
};

export function UiMenu<T extends object>({
  trigger,
  className,
  popoverClassName,
  children,
  ...props
}: UiMenuProps<T>) {
  return (
    <AriaMenuTrigger>
      {trigger}
      <AriaPopover className={cx("av-ui-menu-popover", popoverClassName)}>
        <AriaMenu {...props} className={cx("av-ui-menu", className)}>
          {children}
        </AriaMenu>
      </AriaPopover>
    </AriaMenuTrigger>
  );
}

type UiMenuItemProps = Omit<AriaMenuItemProps, "className"> & {
  className?: string;
  icon?: UiIconName | false;
};

export function UiMenuItem({ className, icon = "action", children, ...props }: UiMenuItemProps) {
  return (
    <AriaMenuItem
      {...props}
      className={({ isFocused, isDisabled }) => cx(
        "av-ui-menu-item",
        isFocused && "is-focused",
        isDisabled && "is-disabled",
        className,
      )}
    >
      {icon ? <UiIcon name={icon} /> : null}
      <span className='av-ui-menu-item-label'>{children}</span>
    </AriaMenuItem>
  );
}

type UiTableColumnMeta = {
  className?: string;
  headerClassName?: string;
  label?: string;
};

export function UiDataTable<TData>({
  table,
  ariaLabel,
  getRowClassName,
}: {
  table: TanStackTable<TData>;
  ariaLabel: string;
  getRowClassName?: (row: TData, index: number) => string | undefined;
}) {
  return (
    <div className='av-ui-data-table-shell'>
      <table className='av-ui-data-table' aria-label={ariaLabel}>
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const meta = header.column.columnDef.meta as UiTableColumnMeta | undefined;
                return (
                  <th key={header.id} className={cx(meta?.className, meta?.headerClassName)}>
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row, index) => (
            <tr key={row.id} className={getRowClassName?.(row.original, index)}>
              {row.getVisibleCells().map((cell) => {
                const meta = cell.column.columnDef.meta as UiTableColumnMeta | undefined;
                return (
                  <td key={cell.id} className={meta?.className} data-label={meta?.label}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
