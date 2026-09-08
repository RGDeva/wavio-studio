export function TitleBar() {
  return (
    <div className="titlebar-drag flex items-center h-10 px-4 bg-black border-b border-[#1a1a1a] flex-shrink-0">
      <div className="flex items-center gap-2 titlebar-no-drag select-none">
        <img src="./icon.png" alt="Wavi" className="w-4 h-4 object-contain opacity-80" />
        <span className="text-xs font-semibold text-fg-tertiary tracking-widest uppercase">Wavi Studio</span>
      </div>
    </div>
  );
}
