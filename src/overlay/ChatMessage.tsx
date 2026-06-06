import type { ChatMessage as ChatMsg } from './types';
import { ToolOutput } from './ToolOutput';

interface ChatMessageProps {
  message: ChatMsg;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div className="flex justify-center my-1">
        <span className="text-[10px] text-white/25 font-mono">{message.content}</span>
      </div>
    );
  }

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isUser && (
        <div className="w-5 h-5 rounded-full bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
          <span className="text-[8px] text-cyan-400 font-bold">W</span>
        </div>
      )}
      <div className={`flex flex-col gap-1 max-w-[85%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`px-3 py-2 rounded-xl text-xs leading-relaxed ${
            isUser
              ? 'bg-white/10 text-white/90'
              : 'bg-[#111] border border-white/8 text-white/80'
          }`}
        >
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
        {message.toolOutputs && message.toolOutputs.length > 0 && (
          <div className="w-full space-y-1.5 mt-1">
            {message.toolOutputs.map((output, i) => (
              <ToolOutput key={i} output={output} />
            ))}
          </div>
        )}
        <span className="text-[9px] text-white/20">
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
}
