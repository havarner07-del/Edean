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
    if abs(h1/k1-x)<=1e-9*max(1,x):
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

def rpi(dg):
  f=fr(dg/180)
  if not f:
    return fmt(dg*pi/180)
  n,d=f
  if n==0:
    return "0"
  s="pi" if abs(n)==1 else str(abs(n))+"pi"
  if n<0:
    s="-"+s
  if d!=1:
    s=s+"/"+str(d)
  return s

def pang(s):
  s=s.replace(" ","").lower()
  if "pi" in s:
    s=s.replace("pi","").replace("*","")
    if s=="" or s[0]=="/":
      s="1"+s
    elif s[0]=="-" and (len(s)==1 or s[1]=="/"):
      s="-1"+s[1:]
    if "/" in s:
      a,b=s.split("/")
      return 180*float(a)/float(b)
    return 180*float(s)
  if s.endswith("r"):
    return float(s[:-1])*180/pi
  return float(s)

def ang(p="Angle: "):
  print("deg: 150  rad: 5pi/6 or 2r")
  while True:
    try:
      return pang(input(p))
    except:
      print("Try again")

def quad(t):
  t=t%360
  if t%90==0:
    return "on an axis"
  return "Quadrant "+"I II III IV".split()[int(t//90)]

def refa(t):
  t=t%360
  if t<=90:
    return t
  if t<=180:
    return 180-t
  if t<=270:
    return t-180
  return 360-t

def rt(s,A,B):
  if B==0:
    return "undefined"
  if A==0:
    return "0"
  v=sqrt(A/B)
  e=("-" if s<0 else "")+sqf(A,B)
  if "sqrt" in e or "/" in e:
    e=e+" ~"+str(round(s*v,4))
  return e

def six(sx,X,sy,Y,R):
  print("sin = "+rt(sy,Y,R))
  print("cos = "+rt(sx,X,R))
  print("tan = "+rt(sx*sy,Y,X))
  print("csc = "+rt(sy,R,Y))
  print("sec = "+rt(sx,R,X))
  print("cot = "+rt(sx*sy,X,Y))

def sgn(x):
  return 1 if x>1e-9 else (-1 if x<-1e-9 else 0)

SP={0:(1,0,1),30:(3,1,4),45:(1,1,2),60:(1,3,4),90:(0,1,1)}

def exact():
  t=ang()
  r=refa(t)
  print(fmt(t)+" deg = "+rpi(t)+" rad, "+quad(t))
  print("Ref angle "+fmt(r)+" = "+rpi(r))
  x=t*pi/180
  sx=sgn(cos(x));sy=sgn(sin(x))
  k=round(r)
  if abs(r-k)<1e-9 and k in SP:
    X,Y,R=SP[k]
    print("Unit circle pt (cos,sin):")
    print(" ("+rt(sx,X,R).split(" ~")[0]+", "+rt(sy,Y,R).split(" ~")[0]+")")
    six(sx,X,sy,Y,R)
  else:
    c=cos(x);s=sin(x)
    for n,v,d in (("sin",s,1),("cos",c,1),("tan",s,c),("csc",1,s),("sec",1,c),("cot",c,s)):
      print(n+" = "+(str(round(v/d,5)) if abs(d)>1e-12 else "undefined"))

def ints(a,b):
  fa=fr(a) or (a,1);fb=fr(b) or (b,1)
  L=fa[1]*fb[1]//gcd(fa[1],fb[1])
  return round(a*L),round(b*L)

def point():
  print("Point (x,y) on terminal side")
  x=num("x=");y=num("y=")
  X,Y=ints(x,y)
  print("r = sqrt(x^2+y^2) = "+sq(x*x+y*y))
  t=atan2(y,x)*180/pi
  print(quad(t)+", theta~"+str(round(t%360,3))+" deg")
  six(sgn(X),X*X,sgn(Y),Y*Y,X*X+Y*Y)

def pv(s):
  s=s.replace(" ","").replace("*","")
  g=1
  if s[0]=="-":
    g=-1;s=s[1:]
  d=1
  if "/" in s:
    s,dd=s.split("/");d=int(dd)
  if "sqrt(" in s:
    i=s.find("sqrt(")
    k=int(s[:i]) if s[:i] else 1
    m=int(s[i+5:s.find(")")])
    return g,k*k*m,d*d
  f=fr(float(s))
  return g,f[0]*f[0],(f[1]*d)**2

def given():
  fs=["sin","cos","tan","csc","sec","cot"]
  print("1 sin 2 cos 3 tan")
  print("4 csc 5 sec 6 cot")
  f=int(num("which? "))-1
  print("value, e.g. -3/5, 2sqrt(2)/3")
  g,A,B=pv(input(fs[f]+" = "))
  q=int(num("quadrant 1-4? "))
  sx=[1,-1,-1,1][q-1];sy=[1,1,-1,-1][q-1]
  if f>2:
    A,B=B,A;f-=3
  if f==0:
    Y,R=A,B;X=R-Y;ok=g==sy
  elif f==1:
    X,R=A,B;Y=R-X;ok=g==sx
  else:
    Y,X=A,B;R=X+Y;ok=g==sx*sy
  if not ok:
    print("Sign doesn't fit quadrant!")
  if X<0 or Y<0:
    print("Impossible value")
    return
  print("x^2="+fmt(X)+" y^2="+fmt(Y)+" r^2="+fmt(R))
  six(sx,X,sy,Y,R)

def tri():
  print("Right triangle, C=90")
  print("c=hyp, a opp A, b opp B")
  print("Enter 0 if unknown")
  a=num("a=");b=num("b=");c=num("c=")
  A=num("angle A deg=");B=num("angle B deg=")
  if B and not A:
    A=90-B
  n=(a!=0)+(b!=0)+(c!=0)
  if n==0 or (n==1 and not A):
    print("Need 2 sides, or")
    print("1 side + 1 angle")
    return
  if A:
    x=A*pi/180
    if a:
      c=a/sin(x);b=a/tan(x)
    elif b:
      a=b*tan(x);c=b/cos(x)
    else:
      a=c*sin(x);b=c*cos(x)
  else:
    if a and b:
      c=sqrt(a*a+b*b)
    elif a:
      b=sqrt(c*c-a*a)
    else:
      a=sqrt(c*c-b*b)
    A=atan2(a,b)*180/pi
  B=90-A
  for n,v in (("a",a),("b",b),("c",c)):
    e=sq(v*v)
    print(n+" = "+e+("" if e==str(round(v,4)) or "sqrt" not in e else " ~"+str(round(v,4))))
  print("A = "+str(round(A,4))+" deg")
  print("B = "+str(round(B,4))+" deg")
  print("Area = ab/2 = "+fmt(a*b/2))
  wait()
  fa=fr(a*a);fb=fr(b*b)
  if fa and fb and fa[1]==1 and fb[1]==1:
    print("Trig of angle A:")
    six(1,fb[0],1,fa[0],fa[0]+fb[0])

def form():
  print("SOH CAH TOA")
  print("csc=1/sin sec=1/cos")
  print("cot=1/tan=cos/sin")
  print("sin^2+cos^2=1")
  print("1+tan^2=sec^2")
  print("1+cot^2=csc^2")
  print("x=rcos y=rsin r^2=x^2+y^2")
  print("Positive: All Students")
  print(" Take Calculus (I,II,III,IV)")
  wait()
  print("deg  0  30   45   60  90")
  print("sin  0  1/2  r2/2 r3/2 1")
  print("cos  1  r3/2 r2/2 1/2  0")
  print("tan  0  r3/3 1    r3   und")
  print("(r2 = sqrt(2))")
  print("Cofunction: sin A=cos(90-A)")
  print("Even: cos(-t)=cos t")
  print("Odd: sin(-t)=-sin t, tan")
  print("Period: sin,cos 2pi; tan pi")
  wait()

while True:
  print("== TRIG FUNCTIONS 4.2-4.4 ==")
  print("1 Exact values of angle")
  print("2 Point (x,y) on terminal")
  print("3 One value -> other five")
  print("4 Right triangle solver")
  print("5 Formulas  0 Quit")
  c=num("? ")
  if c==0:
    break
  print("")
  try:
    [0,exact,point,given,tri,form][c]()
  except Exception as x:
    print("Error: "+str(x))
  wait()
