const options = {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
};
const formatter = new Intl.DateTimeFormat('en-US', options);
const partsArrayToObject = (parts)=>{
    const result = {};
    for (const part of parts){
        result[part.type] = part.value;
    }
    return result;
};
export const formatDate = (date)=>{
    const parts = partsArrayToObject(formatter.formatToParts(date));
    const formattedTime = `${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
    const formattedDate = `${parts.month} ${parts.day}, ${parts.year}`;
    return `${formattedTime} · ${formattedDate}`;
};
