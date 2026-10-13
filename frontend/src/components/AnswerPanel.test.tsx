import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AnswerPanel from './AnswerPanel';

afterEach(cleanup);

const itemWithAnswer = (answer: string) => ({
  id: 'answer-1',
  question: 'question',
  response: {
    answer,
    source: 'llm' as const,
    score: null,
    file: null,
    matched_question: null,
  },
  timestamp: 1,
});

describe('AnswerPanel Markdown isolation', () => {
  it('does not create an image request from untrusted Markdown', () => {
    const { container } = render(
      <AnswerPanel item={itemWithAnswer('![tracking pixel](https://untrusted.example/pixel.png)')} />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('tracking pixel')).toBeTruthy();
  });

  it('routes http links through the narrow Electron bridge without renderer navigation', () => {
    const openExternal = vi.fn();
    window.electronAPI!.openExternal = openExternal;
    render(<AnswerPanel item={itemWithAnswer('[安全文件](https://example.com/docs)')} />);

    const link = screen.getByRole('link', { name: '安全文件' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('renders unsafe link schemes as inert text', () => {
    const openExternal = vi.fn();
    window.electronAPI!.openExternal = openExternal;
    render(<AnswerPanel item={itemWithAnswer('[不要開啟](javascript:alert(1))')} />);

    expect(screen.queryByRole('link', { name: '不要開啟' })).toBeNull();
    fireEvent.click(screen.getByText('不要開啟'));
    expect(openExternal).not.toHaveBeenCalled();
  });
});
