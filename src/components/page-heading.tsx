export function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-8">
      <p className="mb-3 text-[10px] font-semibold tracking-[0.18em] text-violet-300 uppercase">
        {eyebrow}
      </p>
      <h1 className="text-3xl leading-tight font-semibold tracking-[-0.035em] sm:text-[38px]">
        {title}
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-7 text-muted">
        {description}
      </p>
    </div>
  );
}
