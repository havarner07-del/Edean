from math import *

def gcd(a,b):
  a=abs(a);b=abs(b)
  while b:
    a,b=b,a%b
  return a

def fr(x):
  s=1
  if x<0:
    s=-1;x=-x
  h0,h1,k0,k1=0,1,1,0
  y=x
  for i in range(20):
    t=int(y)
    h0,h1=h1,t*h1+h0
    k0,k1=k1,t*k1+k0
    if k1>1000:
      return None
    if abs(h1/k1-x)<=1e-7*max(1,x):
      return (s*h1,k1)
    if y-t<1e-12:
      return None
    y=1/(y-t)
  return None

def fmt(x):
  if isinstance(x,int):
    return str(x)
  f=fr(x)
  if f:
    if f[1]==1:
      return str(f[0])
    return str(f[0])+"/"+str(f[1])
  return str(round(x,4))

def num(p):
  while True:
    s=input(p).replace(" ","")
    try:
      if "/" in s:
        a,b=s.split("/")
        x=float(a)/float(b)
      else:
        x=float(s)
      if x==int(x):
        return int(x)
      return x
    except:
      print("Try again")

def wait():
  input("[enter]")

def rad(n):
  k=1;i=2
  while i*i<=n:
    while n%(i*i)==0:
      k*=i;n//=i*i
    i+=1
  return k,n

def sqf(n,d):
  k,m=rad(n*d)
  g=gcd(k,d);k//=g;d//=g
  if m==1:
    s=str(k)
  else:
    s=("" if k==1 else str(k))+"sqrt("+str(m)+")"
  if d!=1:
    s=s+"/"+str(d)
  return s

def sq(x):
  if x==0:
    return "0"
  f=fr(x)
  if f and f[0]>0:
    return sqf(f[0],f[1])
  return str(round(sqrt(x),4))

def sh(v,h):
  if h==0:
    return v
  if h>0:
    return "("+v+"-"+fmt(h)+")"
  return "("+v+"+"+fmt(-h)+")"

def ad(x):
  return (" - " if x<0 else " + ")+fmt(abs(x))

def pt(x,y):
  return "("+x+", "+y+")"

def pm(h,v):
  s=sq(v)
  if "sqrt" not in s and "." not in s:
    r=sqrt(v)
    return [fmt(h+r),fmt(h-r)]
  if h==0:
    return [s,"-"+s]
  return [fmt(h)+"+"+s,fmt(h)+"-"+s]

def pts(lab,h,k,v,hor):
  if hor:
    p=pm(h,v)
    print(lab+pt(p[0],fmt(k)))
    print("   "+pt(p[1],fmt(k)))
  else:
    p=pm(k,v)
    print(lab+pt(fmt(h),p[0]))
    print("   "+pt(fmt(h),p[1]))

def ell(h,k,A,B):
  print(sh("x",h)+"^2/"+fmt(A)+" + "+sh("y",k)+"^2/"+fmt(B)+" = 1")
  print("Center "+pt(fmt(h),fmt(k)))
  if A==B:
    print("CIRCLE r = "+sq(A))
    return
  hor=A>B
  a2=max(A,B);b2=min(A,B);c2=a2-b2
  print("ELLIPSE, major axis "+("horiz" if hor else "vert"))
  print("a="+sq(a2)+" b="+sq(b2)+" c="+sq(c2))
  print("c^2 = a^2 - b^2")
  pts("Vert ",h,k,a2,hor)
  pts("CoV  ",h,k,b2,not hor)
  pts("Foci ",h,k,c2,hor)
  print("e = c/a = "+sq(c2/a2))
  print("Major len 2a, minor 2b")

def hyp(h,k,A,B,hor):
  c2=A+B
  if hor:
    print(sh("x",h)+"^2/"+fmt(A)+" - "+sh("y",k)+"^2/"+fmt(B)+" = 1")
  else:
    print(sh("y",k)+"^2/"+fmt(A)+" - "+sh("x",h)+"^2/"+fmt(B)+" = 1")
  print("HYPERBOLA, opens "+("left/right" if hor else "up/down"))
  print("Center "+pt(fmt(h),fmt(k)))
  print("a="+sq(A)+" b="+sq(B)+" c="+sq(c2))
  print("c^2 = a^2 + b^2")
  pts("Vert ",h,k,A,hor)
  pts("Foci ",h,k,c2,hor)
  wait()
  if hor:
    m=B/A
  else:
    m=A/B
  print("Asymptotes: slope +-"+sq(m))
  print(sh("y",k)+" = +-"+sq(m)+sh("x",h))
  m=sqrt(m)
  print("y = "+fmt(m)+"x"+ad(k-m*h))
  print("y = "+fmt(-m)+"x"+ad(k+m*h))
  print("e = c/a = "+sq(c2/A))

def par(h,k,P,vert):
  p=P/4
  if vert:
    print(sh("x",h)+"^2 = "+fmt(P)+sh("y",k))
    print("PARABOLA opens "+("up" if p>0 else "down"))
    f=pt(fmt(h),fmt(k+p));d="y = "+fmt(k-p);ax="x = "+fmt(h)
    e1=pt(fmt(h-2*p),fmt(k+p));e2=pt(fmt(h+2*p),fmt(k+p))
  else:
    print(sh("y",k)+"^2 = "+fmt(P)+sh("x",h))
    print("PARABOLA opens "+("right" if p>0 else "left"))
    f=pt(fmt(h+p),fmt(k));d="x = "+fmt(h-p);ax="y = "+fmt(k)
    e1=pt(fmt(h+p),fmt(k-2*p));e2=pt(fmt(h+p),fmt(k+2*p))
  print("Vertex "+pt(fmt(h),fmt(k)))
  print("4p = "+fmt(P)+"  p = "+fmt(p))
  print("Focus "+f)
  print("Directrix "+d)
  print("Axis "+ax)
  print("Latus rectum len "+fmt(abs(P)))
  print(" ends "+e1+" "+e2)

def hk():
  return num("h="),num("k=")

def std():
  print("1 Ellipse/circle")
  print(" (x-h)^2/A+(y-k)^2/B=1")
  print("2 Hyperbola (x-h)^2 first")
  print("3 Hyperbola (y-k)^2 first")
  print("  (_)^2/A - (_)^2/B = 1")
  print("4 Parabola (x-h)^2=P(y-k)")
  print("5 Parabola (y-k)^2=P(x-h)")
  c=num("? ")
  h,k=hk()
  if c<4:
    A=num("A=");B=num("B=")
    print("")
    if c==1:
      ell(h,k,A,B)
    else:
      hyp(h,k,A,B,c==2)
  else:
    par(h,k,num("P="),c==4)

def feat():
  print("1 Ellipse  2 Hyperbola")
  print("3 Parabola")
  c=num("? ")
  if c==3:
    print("Vertex:")
    h,k=hk()
    print("1 know focus 2 directrix")
    if num("? ")==1:
      x=num("focus x=");y=num("focus y=")
      if x==h:
        par(h,k,4*(y-k),True)
      else:
        par(h,k,4*(x-h),False)
    else:
      print("1 y=number  2 x=number")
      t=num("? ");d=num("number=")
      if t==1:
        par(h,k,4*(k-d),True)
      else:
        par(h,k,4*(h-d),False)
    return
  print("Center:")
  h,k=hk()
  hor=num("1 horiz 2 vert? ")==1
  print("a = center to vertex")
  a=num("a=")
  if num("1 know b 2 know c? ")==1:
    b2=num("b=")**2
  else:
    cc=num("c=")**2
    b2=a*a-cc if c==1 else cc-a*a
  print("")
  if c==1:
    if hor:
      ell(h,k,a*a,b2)
    else:
      ell(h,k,b2,a*a)
  else:
    hyp(h,k,a*a,b2,hor)

def gen():
  print("Ax^2+Cy^2+Dx+Ey+F=0")
  A=num("A=");C=num("C=");D=num("D=");E=num("E=");F=num("F=")
  print("")
  if A!=0 and C!=0:
    h=-D/(2*A);k=-E/(2*C)
    R=-F+A*h*h+C*k*k
    print("Complete the square:")
    print(fmt(A)+sh("x",h)+"^2"+ad(C)+sh("y",k)+"^2 = "+fmt(R))
    if R==0:
      print("Degenerate (R=0)")
      return
    if A*C>0:
      if R/A<0:
        print("No graph (R<0)")
        return
      ell(h,k,R/A,R/C)
    elif R/A>0:
      hyp(h,k,R/A,-R/C,True)
    else:
      hyp(h,k,R/C,-R/A,False)
  elif A!=0:
    h=-D/(2*A)
    if E==0:
      print("Not a parabola (E=0)")
      return
    par(h,(A*h*h-F)/E,-E/A,True)
  elif C!=0:
    k=-E/(2*C)
    if D==0:
      print("Not a parabola (D=0)")
      return
    par((C*k*k-F)/D,k,-D/C,False)
  else:
    print("Line, not a conic")

def form():
  print("ELLIPSE: a biggest, c^2=a^2-b^2")
  print(" foci on major axis, e=c/a<1")
  print("HYPERBOLA: c^2=a^2+b^2, e>1")
  print(" a^2 under POSITIVE term")
  print(" asym slope b/a (horiz)")
  print("  or a/b (vert)")
  print("PARABOLA: (x-h)^2=4p(y-k)")
  print(" focus p from vertex,")
  print(" directrix p other side")
  wait()
  print("GENERAL Ax^2+Cy^2+Dx+Ey+F=0")
  print(" A=C: circle")
  print(" AC>0: ellipse")
  print(" AC<0: hyperbola")
  print(" A or C = 0: parabola")
  wait()

while True:
  print("== CONICS (Ch 10) ==")
  print("1 From standard equation")
  print("2 From features (a,b,c..)")
  print("3 From general form")
  print("4 Formulas")
  print("0 Quit")
  c=num("? ")
  if c==0:
    break
  print("")
  if c==1:
    std()
  elif c==2:
    feat()
  elif c==3:
    gen()
  else:
    form()
  wait()
