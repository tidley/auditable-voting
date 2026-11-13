import { parseDateTime } from '@internationalized/date';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Calendar, CalendarCell, CalendarGrid, DateInput, DatePicker, DateSegment, Dialog, Group, Heading, I18nProvider, Label, Popover } from 'react-aria-components';

export default function UiDateTimeField({ label, value, onChange, isDisabled = false }: { label: string; value: string; onChange: (value: string) => void; isDisabled?: boolean }) {
  return <I18nProvider locale='en-GB'>
    <DatePicker className='av-ui-field av-ui-date-picker' value={value ? parseDateTime(value) : null} onChange={date => onChange(date?.toString() ?? '')} granularity='minute' hourCycle={24} isDisabled={isDisabled}>
      <Label className='av-ui-label'>{label}</Label>
      <Group className='av-ui-input av-ui-date-group'>
        <DateInput className='av-ui-date-input' aria-label={label}>{segment => <DateSegment segment={segment} className='av-ui-date-segment' />}</DateInput>
        <Button className='av-ui-date-trigger' aria-label='Choose date and time'><CalendarDays size={18} aria-hidden='true' /></Button>
      </Group>
      <Popover className='av-ui-calendar-popover'>
        <Dialog className='av-ui-calendar-dialog'>
          <Calendar className='av-ui-calendar'>
            <header className='av-ui-calendar-header'>
              <Button slot='previous' className='av-ui-calendar-month' aria-label='Previous month'><ChevronLeft size={18} aria-hidden='true' /></Button>
              <Heading />
              <Button slot='next' className='av-ui-calendar-month' aria-label='Next month'><ChevronRight size={18} aria-hidden='true' /></Button>
            </header>
            <CalendarGrid>{date => <CalendarCell date={date} className='av-ui-calendar-cell' />}</CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </DatePicker>
  </I18nProvider>;
}
