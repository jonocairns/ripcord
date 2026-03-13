import { useCallback, useRef, useState } from 'react';

export const useScreenShareZoom = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPosition({ x: 0, y: 0 });
    setIsDragging(false);
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!containerRef.current) return;
      e.preventDefault();

      const container = containerRef.current;
      const rect = container.getBoundingClientRect();

      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const offsetX = mouseX - centerX;
      const offsetY = mouseY - centerY;

      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const newZoom = Math.max(1, Math.min(5, zoom + delta));

      if (newZoom === 1) {
        resetZoom();
        return;
      }

      const zoomRatio = newZoom / zoom;
      setPosition((prev) => ({
        x: prev.x * zoomRatio + offsetX * (zoomRatio - 1),
        y: prev.y * zoomRatio + offsetY * (zoomRatio - 1)
      }));

      setZoom(newZoom);
    },
    [zoom, resetZoom]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (zoom > 1) {
        setIsDragging(true);
        setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
      }
    },
    [zoom, position]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging && zoom > 1) {
        setPosition({
          x: e.clientX - dragStart.x,
          y: e.clientY - dragStart.y
        });
      }
    },
    [isDragging, dragStart, zoom]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const getCursor = useCallback(() => {
    if (zoom > 1) {
      return isDragging ? 'grabbing' : 'grab';
    }
    return 'default';
  }, [zoom, isDragging]);

  return {
    containerRef,
    zoom,
    position,
    isDragging,
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    getCursor,
    resetZoom
  };
};
